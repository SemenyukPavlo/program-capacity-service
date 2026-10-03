import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService, isPgError } from '../database/database.service';
import { Errors, DomainError } from '../common/errors/domain-error';
import { toCurrency } from '../common/money/currency';
import { formatSigned, Money } from '../common/money/money';
import { FxService } from '../fx/fx.service';
import { accessiblePrograms, assertProgramAccess, Principal } from '../auth/principal';
import { MetricsService } from '../observability/metrics.service';
import { CapacityRepository, Program, Queryable, Reservation, SortOrder } from './capacity.repository';
import { planCancel, planRelease, ReleasePlan, ReservationSource, ReservationStatus } from './domain/reservation';
import { HttpResult, IdempotencyContext, IdempotencyService } from './idempotency.service';
import { CapacityView, ReservationResult, ReservationView, toCapacityView, toReservationView } from './views';

export interface RequestContext {
  correlationId?: string;
  idempotency?: IdempotencyContext;
}

export interface ReserveInput {
  invoiceId: string;
  amount: string;
  currency: string;
}

export interface ReleaseInput {
  amount?: string;
  currency?: string;
}

@Injectable()
export class CapacityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: CapacityRepository,
    private readonly fx: FxService,
    private readonly idempotency: IdempotencyService,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------- reads

  async getCapacity(principal: Principal, programId: string): Promise<CapacityView> {
    assertProgramAccess(principal, programId);
    return toCapacityView(await this.requireProgram(this.db.pool, programId));
  }

  async listPrograms(principal: Principal): Promise<CapacityView[]> {
    const programs = await this.repo.listPrograms(this.db.pool, accessiblePrograms(principal));
    return programs.map(toCapacityView);
  }

  async getReservation(principal: Principal, programId: string, invoiceId: string): Promise<ReservationView> {
    assertProgramAccess(principal, programId);
    return toReservationView(await this.requireReservation(this.db.pool, programId, invoiceId));
  }

  async listReservations(
    principal: Principal,
    programId: string,
    opts: { status?: ReservationStatus; order: SortOrder; cursor?: string; limit: number },
  ): Promise<{ items: ReservationView[]; nextCursor: string | null }> {
    assertProgramAccess(principal, programId);
    await this.requireProgram(this.db.pool, programId);
    const rows = await this.repo.listReservations(this.db.pool, programId, {
      status: opts.status,
      order: opts.order,
      cursor: opts.cursor ? decodeCursor(opts.cursor) : undefined,
      limit: opts.limit + 1,
    });
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toReservationView),
      nextCursor: rows.length > opts.limit && last ? encodeCursor(last.seq) : null,
    };
  }

  async listLedger(
    principal: Principal,
    programId: string,
    opts: { order: SortOrder; cursor?: string; limit: number },
  ) {
    assertProgramAccess(principal, programId);
    const { currency } = await this.requireProgram(this.db.pool, programId);
    const fmt = (v: string) => formatSigned(v, currency);
    const rows = await this.repo.listLedger(this.db.pool, programId, {
      order: opts.order,
      cursor: opts.cursor ? decodeCursor(opts.cursor) : undefined,
      limit: opts.limit + 1,
    });
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return {
      nextCursor: rows.length > opts.limit && last ? encodeCursor(Number(last.id)) : null,
      items: page.map((r) => ({
        id: Number(r.id),
        reservationId: r.reservation_id,
        type: r.type,
        reservedDelta: fmt(r.reserved_delta),
        limitDelta: fmt(r.limit_delta),
        reservedAfter: fmt(r.reserved_after),
        limitAfter: fmt(r.limit_after),
        actor: r.actor,
        correlationId: r.correlation_id,
        details: r.details,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  // ---------------------------------------------------------------- reserve

  async reserve(
    principal: Principal,
    programId: string,
    input: ReserveInput,
    ctx: RequestContext = {},
  ): Promise<HttpResult<ReservationResult>> {
    try {
      const result = await this.doReserve(principal, programId, input, ctx);
      this.metrics.capacityOperations.inc({
        operation: 'reserve',
        outcome: result.status === 201 && !result.replayed ? 'created' : 'replayed',
      });
      return result;
    } catch (err) {
      this.metrics.capacityOperations.inc({
        operation: 'reserve',
        outcome: err instanceof DomainError ? err.code.toLowerCase() : 'error',
      });
      throw err;
    }
  }

  private async doReserve(
    principal: Principal,
    programId: string,
    input: ReserveInput,
    ctx: RequestContext,
  ): Promise<HttpResult<ReservationResult>> {
    assertProgramAccess(principal, programId);
    const invoiceAmount = Money.parse(input.amount, toCurrency(input.currency));
    if (!invoiceAmount.isPositive()) {
      throw Errors.validation('INVALID_AMOUNT', 'Amount must be greater than zero');
    }

    // Read outside the transaction: cheap pre-checks and, crucially, the FX lookup, which may be
    // a network call and must not hold a database transaction open. The conditional UPDATE
    // below re-checks status and currency atomically, so this read is only advisory.
    const program = await this.requireProgram(this.db.pool, programId);
    assertActive(program);
    const conversion = await this.fx.convertForReservation(invoiceAmount, program.currency);

    try {
      return await this.db.transaction((tx) =>
        this.idempotency.run(tx, ctx.idempotency, async () => {
          const existing = await this.repo.findReservation(tx, programId, input.invoiceId);
          if (existing)
            return this.duplicateReservation(existing, invoiceAmount, await this.requireProgram(tx, programId));

          const reserved = await this.repo.tryReserveCapacity(tx, programId, conversion.converted);
          if (!reserved) throw await this.explainReserveFailure(tx, programId, conversion.converted);

          const reservation = await this.repo.insertReservation(tx, {
            programId,
            invoiceId: input.invoiceId,
            invoiceAmount,
            programAmount: conversion.converted,
            fxRate: conversion.rate.toString(),
            fxRateSource: conversion.source,
            fxRateAt: conversion.asOf,
            source: 'API',
            createdBy: principal.subject,
          });
          await this.repo.insertLedger(tx, {
            program: reserved,
            reservationId: reservation.id,
            type: 'RESERVE',
            reservedDelta: conversion.converted.amount.toString(),
            actor: principal.subject,
            correlationId: ctx.correlationId,
            details: {
              invoiceId: input.invoiceId,
              invoiceAmount: invoiceAmount.toJSON(),
              fxRate: conversion.rate.toString(),
            },
          });
          await this.repo.recordCapacityChange(tx, reserved, 'RESERVE', this.config.KAFKA_TOPIC_CAPACITY_EVENTS);
          return {
            status: 201,
            body: { reservation: toReservationView(reservation), capacity: toCapacityView(reserved) },
          };
        }),
      );
    } catch (err) {
      // Two concurrent first-time reservations of the same invoice: the loser's transaction
      // (including its capacity increment) was rolled back by the unique constraint.
      if (
        isPgError(err, '23505') &&
        (err as { constraint?: string }).constraint === 'reservations_program_invoice_uq'
      ) {
        const existing = await this.requireReservation(this.db.pool, programId, input.invoiceId);
        return this.duplicateReservation(existing, invoiceAmount, await this.requireProgram(this.db.pool, programId));
      }
      throw err;
    }
  }

  /** Same invoice + same amount = safe client retry (200). Anything else is a conflict. */
  private duplicateReservation(
    existing: Reservation,
    requested: Money,
    program: Program,
  ): HttpResult<ReservationResult> {
    if (!existing.invoiceAmount.equals(requested)) {
      throw Errors.conflict('INVOICE_ALREADY_RESERVED', `Invoice ${existing.invoiceId} already has a reservation`, {
        existingAmount: existing.invoiceAmount.toJSON(),
        existingStatus: existing.status,
      });
    }
    return {
      status: 200,
      body: { reservation: toReservationView(existing), capacity: toCapacityView(program) },
    };
  }

  private async explainReserveFailure(tx: Queryable, programId: string, amount: Money): Promise<DomainError> {
    const program = await this.requireProgram(tx, programId);
    if (program.status !== 'ACTIVE') return notActive(program);
    if (program.currency !== amount.currency) {
      return Errors.conflict('PROGRAM_CURRENCY_CHANGED', 'Program currency changed during the request; retry', {
        programCurrency: program.currency,
      });
    }
    return Errors.conflict('INSUFFICIENT_CAPACITY', 'Insufficient program capacity', {
      requested: amount.toString(),
      available: toCapacityView(program).available,
      currency: program.currency,
    });
  }

  // ---------------------------------------------------------------- release / cancel

  async release(
    principal: Principal,
    programId: string,
    invoiceId: string,
    input: ReleaseInput,
    ctx: RequestContext = {},
  ): Promise<HttpResult<ReservationResult>> {
    assertProgramAccess(principal, programId);
    if ((input.amount === undefined) !== (input.currency === undefined)) {
      throw Errors.validation('INVALID_RELEASE', 'amount and currency must be provided together');
    }
    const amount = input.amount !== undefined ? Money.parse(input.amount, toCurrency(input.currency!)) : undefined;
    return this.mutateReservation('release', principal.subject, programId, invoiceId, ctx, 'API', (r) =>
      planRelease(r, amount),
    );
  }

  async cancel(
    principal: Principal,
    programId: string,
    invoiceId: string,
    ctx: RequestContext = {},
  ): Promise<HttpResult<ReservationResult>> {
    assertProgramAccess(principal, programId);
    return this.mutateReservation('cancel', principal.subject, programId, invoiceId, ctx, 'API', planCancel);
  }

  /**
   * Shared by API release/cancel and by treasury RESERVATION_RELEASED events.
   * Lock order is always program -> reservation (same as reservation and reconciliation),
   * which rules out deadlocks between these paths.
   */
  async mutateReservation(
    operation: 'release' | 'cancel',
    actor: string,
    programId: string,
    invoiceId: string,
    ctx: RequestContext,
    source: ReservationSource,
    plan: (r: Reservation) => ReleasePlan,
    existingTx?: Queryable,
  ): Promise<HttpResult<ReservationResult>> {
    const work = (tx: Queryable) =>
      this.idempotency.run(tx, ctx.idempotency, async () => {
        const program = await this.requireProgram(tx, programId, true);
        const reservation = await this.requireReservation(tx, programId, invoiceId, true);
        const p = plan(reservation);
        if (p.noop) {
          return {
            status: 200,
            body: { reservation: toReservationView(reservation), capacity: toCapacityView(program) },
          };
        }

        await this.repo.updateReservationState(tx, reservation.id, {
          status: p.status,
          outstandingInvoice: reservation.outstandingInvoice.subtract(p.invoiceDelta),
          outstandingProgram: reservation.outstandingProgram.subtract(p.programDelta),
          localChange: true,
        });
        const updated = await this.repo.changeReserved(tx, programId, `-${p.programDelta.amount.toString()}`);
        const type = operation === 'release' ? 'RELEASE' : 'CANCEL';
        await this.repo.insertLedger(tx, {
          program: updated,
          reservationId: reservation.id,
          type,
          reservedDelta: `-${p.programDelta.amount.toString()}`,
          actor,
          correlationId: ctx.correlationId,
          details: { invoiceId, invoiceDelta: p.invoiceDelta.toJSON(), source },
        });
        await this.repo.recordCapacityChange(tx, updated, type, this.config.KAFKA_TOPIC_CAPACITY_EVENTS);
        const after = await this.requireReservation(tx, programId, invoiceId);
        return { status: 200, body: { reservation: toReservationView(after), capacity: toCapacityView(updated) } };
      });

    try {
      const result = existingTx ? await work(existingTx) : await this.db.transaction(work);
      this.metrics.capacityOperations.inc({ operation, outcome: 'ok' });
      return result;
    } catch (err) {
      this.metrics.capacityOperations.inc({
        operation,
        outcome: err instanceof DomainError ? err.code.toLowerCase() : 'error',
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------- helpers

  private async requireProgram(q: Queryable, programId: string, forUpdate = false): Promise<Program> {
    const program = await this.repo.findProgram(q, programId, { forUpdate });
    if (!program) throw Errors.notFound('PROGRAM_NOT_FOUND', `Program ${programId} not found`);
    return program;
  }

  private async requireReservation(
    q: Queryable,
    programId: string,
    invoiceId: string,
    forUpdate = false,
  ): Promise<Reservation> {
    const r = await this.repo.findReservation(q, programId, invoiceId, { forUpdate });
    if (!r) throw Errors.notFound('RESERVATION_NOT_FOUND', `No reservation for invoice ${invoiceId}`);
    return r;
  }
}

function assertActive(program: Program): void {
  if (program.status !== 'ACTIVE') throw notActive(program);
}

function notActive(program: Program): DomainError {
  return Errors.conflict('PROGRAM_NOT_ACTIVE', `Program ${program.id} is ${program.status}`, {
    programStatus: program.status,
  });
}

function encodeCursor(position: number): string {
  return Buffer.from(String(position)).toString('base64url');
}

function decodeCursor(cursor: string): number {
  const decoded = /^[A-Za-z0-9_-]+$/.test(cursor) ? Buffer.from(cursor, 'base64url').toString() : '';
  const seq = /^\d{1,15}$/.test(decoded) ? Number(decoded) : NaN;
  if (!Number.isSafeInteger(seq)) throw Errors.validation('INVALID_CURSOR', 'Invalid pagination cursor');
  return seq;
}
