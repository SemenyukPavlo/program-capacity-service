import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import { Errors } from '../common/errors/domain-error';
import { formatSigned, Money, MoneyDecimal } from '../common/money/money';
import { CapacityRepository, Program, Queryable, Reservation } from '../capacity/capacity.repository';
import { applyReconciledOutstanding } from '../capacity/domain/reservation';
import { planReconciliation } from '../capacity/domain/reconciliation';
import { MetricsService } from '../observability/metrics.service';
import { ProgramSnapshot } from './treasury.messages';

export const TREASURY_ACTOR = 'treasury';

export type ReconciliationOutcome = 'applied' | 'requires_review';

interface DiscrepancyRecord {
  invoiceId: string;
  reason: string;
  from?: string;
  to?: string;
}

/**
 * Applies a full-state treasury snapshot to one program. Must run inside the caller's
 * transaction with the program row already locked (or absent).
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly repo: CapacityRepository,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async apply(
    tx: Queryable,
    existing: Program | null,
    msg: ProgramSnapshot,
    messageId: string,
  ): Promise<ReconciliationOutcome> {
    const asOf = new Date(msg.asOf);
    const limit = Money.parse(msg.limit, msg.currency);
    const snapshotItems = msg.reservations.map((r) => ({
      invoiceId: r.invoiceId,
      outstanding: Money.parse(r.outstandingAmount, msg.currency),
    }));

    let program =
      existing ??
      (await this.repo.insertProgram(tx, {
        id: msg.programId,
        currency: msg.currency,
        limit: Money.zero(msg.currency),
        status: msg.status,
        seq: null,
      }));

    if (program.currency !== msg.currency && (await this.repo.hasReservations(tx, program.id))) {
      throw Errors.unprocessable(
        'PROGRAM_CURRENCY_IMMUTABLE',
        `Snapshot changes program currency ${program.currency} -> ${msg.currency} but the program has reservations`,
      );
    }

    const locals = await this.repo.lockReservationsForReconciliation(
      tx,
      program.id,
      snapshotItems.map((i) => i.invoiceId),
    );
    const byId = new Map(locals.map((r) => [r.id, r]));
    const plan = planReconciliation(
      locals.map((r) => ({
        id: r.id,
        invoiceId: r.invoiceId,
        outstandingProgram: r.outstandingProgram,
        lastLocalChangeAt: r.lastLocalChangeAt,
      })),
      snapshotItems,
      asOf,
    );

    const reservedBefore = program.reserved;
    const delta = plan.adjustments
      .reduce((acc, a) => acc.plus(a.to.amount).minus(a.from.amount), new MoneyDecimal(0))
      .plus(plan.creations.reduce((acc, c) => acc.plus(c.amount.amount), new MoneyDecimal(0)));

    const discrepancies: DiscrepancyRecord[] = [
      ...plan.adjustments.map((a) => ({
        invoiceId: a.invoiceId,
        reason: a.reason,
        from: a.from.toString(),
        to: a.to.toString(),
      })),
      ...plan.creations.map((c) => ({ invoiceId: c.invoiceId, reason: c.reason, to: c.amount.toString() })),
    ];
    const kept = plan.kept.map((k) => ({ invoiceId: k.invoiceId, reason: k.reason }));

    if (this.exceedsDriftGuard(delta, limit, program.limit)) {
      // Do not auto-apply a suspicious snapshot; advance seq so it is not retried forever and
      // leave the program untouched for an operator to review.
      await this.repo.setTreasurySeq(tx, program.id, msg.seq);
      await this.recordRun(tx, program, msg, messageId, 'REQUIRES_REVIEW', program, discrepancies, kept);
      this.metrics.reconciliationRuns.inc({ status: 'requires_review' });
      this.logger.error(
        { programId: program.id, drift: delta.toString(), seq: msg.seq },
        'Reconciliation drift exceeds guard; snapshot NOT applied, requires review',
      );
      return 'requires_review';
    }

    const before = program;
    program = await this.repo.updateProgramTerms(tx, program.id, {
      currency: msg.currency,
      limit,
      status: msg.status,
      seq: msg.seq,
      reconciledAt: new Date(),
    });
    if (!before.limit.equals(limit) || existing === null) {
      await this.repo.insertLedger(tx, {
        program,
        type: 'LIMIT_CHANGE',
        reservedDelta: '0',
        limitDelta: limit.amount.minus(existing ? before.limit.amount : 0).toString(),
        actor: TREASURY_ACTOR,
        correlationId: messageId,
        details: { via: 'RECONCILIATION', seq: msg.seq },
      });
    }
    if (before.status !== msg.status) {
      await this.repo.insertLedger(tx, {
        program,
        type: 'STATUS_CHANGE',
        reservedDelta: '0',
        actor: TREASURY_ACTOR,
        correlationId: messageId,
        details: { from: before.status, to: msg.status, via: 'RECONCILIATION' },
      });
    }

    // Running reserved amount so each ledger entry carries an accurate reserved_after.
    let running = new MoneyDecimal(reservedBefore.amount);
    const ledgerAt = (reserved: InstanceType<typeof MoneyDecimal>): Program => ({
      ...program,
      reserved: Money.of(reserved, program.currency),
    });

    for (const adj of plan.adjustments) {
      const r = byId.get(adj.reservationId) as Reservation;
      const next = applyReconciledOutstanding(r, adj.to);
      await this.repo.updateReservationState(tx, r.id, { ...next, localChange: false });
      const change = adj.to.amount.minus(adj.from.amount);
      running = running.plus(change);
      await this.repo.insertLedger(tx, {
        program: ledgerAt(running),
        reservationId: r.id,
        type: 'RECON_ADJUSTMENT',
        reservedDelta: change.toString(),
        actor: TREASURY_ACTOR,
        correlationId: messageId,
        details: { invoiceId: adj.invoiceId, reason: adj.reason, from: adj.from.toString(), to: adj.to.toString() },
      });
    }

    for (const c of plan.creations) {
      const created = await this.repo.insertReservation(tx, {
        programId: program.id,
        invoiceId: c.invoiceId,
        // Treasury reports program-currency amounts only; original invoice currency is unknown.
        invoiceAmount: c.amount,
        programAmount: c.amount,
        fxRate: '1',
        fxRateSource: 'reconciliation',
        fxRateAt: asOf,
        source: 'RECONCILIATION',
        createdBy: TREASURY_ACTOR,
        lastLocalChangeAt: asOf,
      });
      running = running.plus(c.amount.amount);
      await this.repo.insertLedger(tx, {
        program: ledgerAt(running),
        reservationId: created.id,
        type: 'RECON_ADJUSTMENT',
        reservedDelta: c.amount.amount.toString(),
        actor: TREASURY_ACTOR,
        correlationId: messageId,
        details: { invoiceId: c.invoiceId, reason: c.reason, to: c.amount.toString() },
      });
    }

    // reserved_amount is recomputed from the rows rather than trusted incrementally. If it
    // differs from the running total, the aggregate had drifted from its rows (a bug or manual
    // DB edit); record the correction rather than hiding it.
    program = await this.repo.recomputeReserved(tx, program.id);
    if (!program.reserved.amount.equals(running)) {
      const correction = program.reserved.amount.minus(running);
      this.logger.error(
        { programId: program.id, correction: correction.toString() },
        'Internal reserved_amount drift corrected',
      );
      discrepancies.push({
        invoiceId: '*',
        reason: 'INTERNAL_AGGREGATE_DRIFT',
        to: formatSigned(correction, program.currency),
      });
      await this.repo.insertLedger(tx, {
        program,
        type: 'RECON_ADJUSTMENT',
        reservedDelta: correction.toString(),
        actor: TREASURY_ACTOR,
        correlationId: messageId,
        details: { reason: 'INTERNAL_AGGREGATE_DRIFT' },
      });
    }

    await this.repo.recordCapacityChange(tx, program, 'RECONCILIATION', this.config.KAFKA_TOPIC_CAPACITY_EVENTS);
    await this.recordRun(tx, before, msg, messageId, 'APPLIED', program, discrepancies, kept, reservedBefore);

    this.metrics.reconciliationRuns.inc({ status: 'applied' });
    for (const d of discrepancies) this.metrics.reconciliationDiscrepancies.inc({ reason: d.reason });
    this.metrics.reconciliationDrift.set(
      { program_id: program.id },
      Math.abs(program.reserved.amount.minus(reservedBefore.amount).toNumber()),
    );
    const log = { programId: program.id, seq: msg.seq, discrepancies: discrepancies.length, kept: kept.length };
    if (discrepancies.length) this.logger.warn(log, 'Reconciliation applied with discrepancies');
    else this.logger.log(log, 'Reconciliation applied, no discrepancies');
    return 'applied';
  }

  private exceedsDriftGuard(delta: InstanceType<typeof MoneyDecimal>, newLimit: Money, oldLimit: Money): boolean {
    const ratio = this.config.RECON_MAX_AUTO_DRIFT_RATIO;
    if (ratio <= 0 || delta.isZero()) return false;
    const base = MoneyDecimal.max(newLimit.amount, oldLimit.amount);
    if (base.isZero()) return false;
    return delta.abs().div(base).greaterThan(ratio);
  }

  private async recordRun(
    tx: Queryable,
    before: Program,
    msg: ProgramSnapshot,
    messageId: string,
    status: 'APPLIED' | 'REQUIRES_REVIEW',
    after: Program,
    discrepancies: DiscrepancyRecord[],
    kept: { invoiceId: string; reason: string }[],
    reservedBefore: Money = before.reserved,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO reconciliation_runs (
         id, program_id, message_id, seq, as_of, status,
         limit_before, limit_after, reserved_before, reserved_after, discrepancies)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        randomUUID(),
        before.id,
        messageId,
        msg.seq,
        msg.asOf,
        status,
        before.limit.amount.toString(),
        after.limit.amount.toString(),
        reservedBefore.amount.toString(),
        after.reserved.amount.toString(),
        JSON.stringify({ discrepancies, kept }),
      ],
    );
  }
}
