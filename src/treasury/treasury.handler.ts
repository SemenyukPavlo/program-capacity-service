import { Inject, Injectable, Logger } from '@nestjs/common';
import { ZodError, ZodTypeAny } from 'zod';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import { DomainError } from '../common/errors/domain-error';
import { Money } from '../common/money/money';
import { CapacityRepository, Program, Queryable } from '../capacity/capacity.repository';
import { CapacityService } from '../capacity/capacity.service';
import { planRelease } from '../capacity/domain/reservation';
import { MetricsService } from '../observability/metrics.service';
import { ReconciliationService, TREASURY_ACTOR } from './reconciliation.service';
import {
  ProgramSnapshotSchema,
  ProgramUpserted,
  ProgramUpsertedSchema,
  ReservationReleased,
  ReservationReleasedSchema,
  TreasuryMessage,
} from './treasury.messages';

export type MessageOutcome = 'applied' | 'duplicate' | 'stale' | 'requires_review';

export interface IncomingMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: Buffer | null;
}

/** Not retryable: malformed or semantically rejected. Goes to the DLQ. */
export class PoisonMessageError extends Error {
  constructor(
    message: string,
    readonly eventId?: string,
  ) {
    super(message);
  }
}

const SCHEMAS: Record<string, ZodTypeAny> = {
  PROGRAM_UPSERTED: ProgramUpsertedSchema,
  RESERVATION_RELEASED: ReservationReleasedSchema,
  PROGRAM_SNAPSHOT: ProgramSnapshotSchema,
};

/**
 * Applies one treasury message exactly once:
 *  - de-duplicated by eventId (processed_messages row written in the same transaction);
 *  - ordered by per-program seq (anything <= last applied seq is stale and skipped);
 *  - the Kafka offset is committed by the caller only after this transaction commits.
 */
@Injectable()
export class TreasuryHandler {
  private readonly logger = new Logger(TreasuryHandler.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly repo: CapacityRepository,
    private readonly capacity: CapacityService,
    private readonly reconciliation: ReconciliationService,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  parse(raw: IncomingMessage): TreasuryMessage {
    let json: unknown;
    try {
      json = JSON.parse(raw.value?.toString('utf8') ?? '');
    } catch {
      throw new PoisonMessageError('Message is not valid JSON');
    }
    const type = (json as { type?: unknown })?.type;
    const eventId =
      typeof (json as { eventId?: unknown })?.eventId === 'string' ? (json as { eventId: string }).eventId : undefined;
    const schema = typeof type === 'string' ? SCHEMAS[type] : undefined;
    if (!schema) throw new PoisonMessageError(`Unknown message type: ${String(type)}`, eventId);
    try {
      return schema.parse(json) as TreasuryMessage;
    } catch (err) {
      const detail =
        err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : String(err);
      throw new PoisonMessageError(`Schema validation failed: ${detail}`, eventId);
    }
  }

  async handle(raw: IncomingMessage): Promise<MessageOutcome> {
    const msg = this.parse(raw);
    if (raw.key && raw.key !== msg.programId) {
      this.logger.warn(
        { key: raw.key, programId: msg.programId },
        'Kafka key does not match programId; ordering not guaranteed',
      );
    }

    try {
      const outcome = await this.db.transaction(async (tx) => {
        const fresh = await tx.query(
          `INSERT INTO processed_messages (message_id, topic, partition, "offset", outcome)
           VALUES ($1, $2, $3, $4, 'processing') ON CONFLICT DO NOTHING RETURNING 1`,
          [msg.eventId, raw.topic, raw.partition, raw.offset],
        );
        if (fresh.rowCount === 0) return 'duplicate' as const;

        const program = await this.repo.findProgram(tx, msg.programId, { forUpdate: true });
        const result = await this.apply(tx, program, msg);
        await tx.query(`UPDATE processed_messages SET outcome = $2 WHERE message_id = $1`, [msg.eventId, result]);
        return result;
      });
      this.metrics.kafkaMessages.inc({ topic: raw.topic, type: msg.type, outcome });
      this.logger.log(
        { eventId: msg.eventId, type: msg.type, programId: msg.programId, seq: msg.seq, outcome },
        'Treasury message processed',
      );
      return outcome;
    } catch (err) {
      if (err instanceof DomainError) {
        throw new PoisonMessageError(`${err.code}: ${err.message}`, msg.eventId);
      }
      throw err;
    }
  }

  private async apply(tx: Queryable, program: Program | null, msg: TreasuryMessage): Promise<MessageOutcome> {
    const lastSeq = program?.lastTreasurySeq ?? null;
    if (lastSeq !== null && msg.seq <= lastSeq) {
      this.logger.warn({ programId: msg.programId, seq: msg.seq, lastSeq }, 'Stale treasury message ignored');
      return 'stale';
    }
    // Gaps are tolerated for incremental events (apply and flag): the next snapshot is
    // authoritative and will correct anything a missing event would have changed.
    if (lastSeq !== null && msg.type !== 'PROGRAM_SNAPSHOT' && msg.seq > lastSeq + 1) {
      this.metrics.treasurySeqGaps.inc();
      this.logger.warn({ programId: msg.programId, seq: msg.seq, lastSeq }, 'Treasury sequence gap detected');
    }

    switch (msg.type) {
      case 'PROGRAM_UPSERTED':
        await this.upsertProgram(tx, program, msg);
        return 'applied';
      case 'RESERVATION_RELEASED':
        await this.releaseFromTreasury(tx, program, msg);
        return 'applied';
      case 'PROGRAM_SNAPSHOT':
        return this.reconciliation.apply(tx, program, msg, msg.eventId);
    }
  }

  private async upsertProgram(tx: Queryable, program: Program | null, msg: ProgramUpserted): Promise<void> {
    const limit = Money.parse(msg.limit, msg.currency);
    if (!program) {
      const created = await this.repo.insertProgram(tx, {
        id: msg.programId,
        currency: msg.currency,
        limit,
        status: msg.status,
        seq: msg.seq,
      });
      await this.repo.insertLedger(tx, {
        program: created,
        type: 'LIMIT_CHANGE',
        reservedDelta: '0',
        limitDelta: limit.amount.toString(),
        actor: TREASURY_ACTOR,
        correlationId: msg.eventId,
        details: { created: true, seq: msg.seq },
      });
      await this.repo.recordCapacityChange(tx, created, 'PROGRAM_CREATED', this.config.KAFKA_TOPIC_CAPACITY_EVENTS);
      return;
    }

    if (program.currency !== msg.currency && (await this.repo.hasReservations(tx, program.id))) {
      throw new DomainError(
        'UNPROCESSABLE',
        'PROGRAM_CURRENCY_IMMUTABLE',
        `Cannot change currency ${program.currency} -> ${msg.currency}: program has reservations`,
      );
    }

    const updated = await this.repo.updateProgramTerms(tx, program.id, {
      currency: msg.currency,
      limit,
      status: msg.status,
      seq: msg.seq,
    });
    // A limit below current utilisation is accepted: availability goes negative and new
    // reservations are refused until repayments bring it back.
    if (program.currency !== msg.currency || !program.limit.equals(limit)) {
      await this.repo.insertLedger(tx, {
        program: updated,
        type: 'LIMIT_CHANGE',
        reservedDelta: '0',
        limitDelta: limit.amount.minus(program.limit.amount).toString(),
        actor: TREASURY_ACTOR,
        correlationId: msg.eventId,
        details: { from: program.limit.toJSON(), to: limit.toJSON(), seq: msg.seq },
      });
    }
    if (program.status !== msg.status) {
      await this.repo.insertLedger(tx, {
        program: updated,
        type: 'STATUS_CHANGE',
        reservedDelta: '0',
        actor: TREASURY_ACTOR,
        correlationId: msg.eventId,
        details: { from: program.status, to: msg.status, seq: msg.seq },
      });
    }
    await this.repo.recordCapacityChange(tx, updated, 'PROGRAM_UPDATED', this.config.KAFKA_TOPIC_CAPACITY_EVENTS);
  }

  private async releaseFromTreasury(tx: Queryable, program: Program | null, msg: ReservationReleased): Promise<void> {
    if (!program) {
      throw new DomainError('NOT_FOUND', 'PROGRAM_NOT_FOUND', `Program ${msg.programId} not found`);
    }
    if ((msg.amount === undefined) !== (msg.currency === undefined)) {
      throw new DomainError('VALIDATION', 'INVALID_RELEASE', 'amount and currency must be provided together');
    }
    const amount = msg.amount !== undefined ? Money.parse(msg.amount, msg.currency!) : undefined;
    await this.capacity.mutateReservation(
      'release',
      TREASURY_ACTOR,
      msg.programId,
      msg.invoiceId,
      { correlationId: msg.eventId },
      'TREASURY',
      (r) => planRelease(r, amount),
      tx,
    );
    await this.repo.setTreasurySeq(tx, msg.programId, msg.seq);
  }
}
