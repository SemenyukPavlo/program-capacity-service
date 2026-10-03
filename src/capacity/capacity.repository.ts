import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { CurrencyCode, toCurrency } from '../common/money/currency';
import { Money, MoneyDecimal, formatSigned } from '../common/money/money';
import { ReservationSource, ReservationStatus } from './domain/reservation';

export type Queryable = Pick<PoolClient, 'query'>;

export type ProgramStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export type SortOrder = 'asc' | 'desc';

export interface Program {
  id: string;
  currency: CurrencyCode;
  limit: Money;
  reserved: Money;
  status: ProgramStatus;
  version: number;
  lastTreasurySeq: number | null;
  lastReconciledAt: Date | null;
  updatedAt: Date;
}

export interface Reservation {
  id: string;
  seq: number;
  programId: string;
  invoiceId: string;
  status: ReservationStatus;
  invoiceAmount: Money;
  outstandingInvoice: Money;
  programAmount: Money;
  outstandingProgram: Money;
  fxRate: string;
  fxRateSource: string;
  fxRateAt: Date;
  source: ReservationSource;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastLocalChangeAt: Date;
  closedAt: Date | null;
}

export type LedgerType = 'RESERVE' | 'RELEASE' | 'CANCEL' | 'LIMIT_CHANGE' | 'STATUS_CHANGE' | 'RECON_ADJUSTMENT';

export interface LedgerEntryInput {
  program: Program;
  reservationId?: string;
  type: LedgerType;
  reservedDelta: string;
  limitDelta?: string;
  actor: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

interface ProgramRow {
  id: string;
  currency: string;
  limit_amount: string;
  reserved_amount: string;
  status: ProgramStatus;
  version: string;
  last_treasury_seq: string | null;
  last_reconciled_at: Date | null;
  updated_at: Date;
}

interface ReservationRow {
  id: string;
  seq: string;
  program_id: string;
  invoice_id: string;
  status: ReservationStatus;
  invoice_currency: string;
  invoice_amount: string;
  outstanding_invoice_amount: string;
  program_currency: string;
  program_amount: string;
  outstanding_program_amount: string;
  fx_rate: string;
  fx_rate_source: string;
  fx_rate_at: Date;
  source: ReservationSource;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  last_local_change_at: Date;
  closed_at: Date | null;
}

const PROGRAM_COLUMNS = `id, currency, limit_amount, reserved_amount, status, version,
  last_treasury_seq, last_reconciled_at, updated_at`;

// Program currency is joined in so amounts can be typed without a second query.
const RESERVATION_SELECT = `
  SELECT r.*, p.currency AS program_currency
    FROM reservations r
    JOIN programs p ON p.id = r.program_id`;

function toProgram(row: ProgramRow): Program {
  const currency = toCurrency(row.currency);
  return {
    id: row.id,
    currency,
    limit: Money.of(row.limit_amount, currency),
    reserved: Money.of(row.reserved_amount, currency),
    status: row.status,
    version: Number(row.version),
    lastTreasurySeq: row.last_treasury_seq === null ? null : Number(row.last_treasury_seq),
    lastReconciledAt: row.last_reconciled_at,
    updatedAt: row.updated_at,
  };
}

function toReservation(row: ReservationRow): Reservation {
  const invoiceCurrency = toCurrency(row.invoice_currency);
  const programCurrency = toCurrency(row.program_currency);
  return {
    id: row.id,
    seq: Number(row.seq),
    programId: row.program_id,
    invoiceId: row.invoice_id,
    status: row.status,
    invoiceAmount: Money.of(row.invoice_amount, invoiceCurrency),
    outstandingInvoice: Money.of(row.outstanding_invoice_amount, invoiceCurrency),
    programAmount: Money.of(row.program_amount, programCurrency),
    outstandingProgram: Money.of(row.outstanding_program_amount, programCurrency),
    fxRate: new MoneyDecimal(row.fx_rate).toString(),
    fxRateSource: row.fx_rate_source,
    fxRateAt: row.fx_rate_at,
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLocalChangeAt: row.last_local_change_at,
    closedAt: row.closed_at,
  };
}

export function availableOf(p: Program): string {
  return formatSigned(p.limit.amount.minus(p.reserved.amount), p.currency);
}

@Injectable()
export class CapacityRepository {
  async findProgram(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<Program | null> {
    const res = await q.query<ProgramRow>(
      `SELECT ${PROGRAM_COLUMNS} FROM programs WHERE id = $1 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return res.rows[0] ? toProgram(res.rows[0]) : null;
  }

  async listPrograms(q: Queryable, ids: string[] | '*'): Promise<Program[]> {
    const res =
      ids === '*'
        ? await q.query<ProgramRow>(`SELECT ${PROGRAM_COLUMNS} FROM programs ORDER BY id`)
        : await q.query<ProgramRow>(`SELECT ${PROGRAM_COLUMNS} FROM programs WHERE id = ANY($1) ORDER BY id`, [ids]);
    return res.rows.map(toProgram);
  }

  /**
   * The core concurrency control: check-and-reserve in ONE statement. The row lock taken by
   * UPDATE serialises concurrent reservations on the same program, and the WHERE clause is
   * re-evaluated against the latest committed row, so capacity can never be over-allocated.
   * Returns null if the program is missing, not ACTIVE, changed currency, or lacks capacity.
   */
  async tryReserveCapacity(tx: Queryable, programId: string, amount: Money): Promise<Program | null> {
    const res = await tx.query<ProgramRow>(
      `UPDATE programs
          SET reserved_amount = reserved_amount + $2,
              version = version + 1,
              updated_at = now()
        WHERE id = $1
          AND status = 'ACTIVE'
          AND currency = $3
          AND limit_amount - reserved_amount >= $2
       RETURNING ${PROGRAM_COLUMNS}`,
      [programId, amount.amount.toString(), amount.currency],
    );
    return res.rows[0] ? toProgram(res.rows[0]) : null;
  }

  /** Signed change of reserved_amount for a program the caller has already locked. */
  async changeReserved(tx: Queryable, programId: string, delta: string): Promise<Program> {
    const res = await tx.query<ProgramRow>(
      `UPDATE programs
          SET reserved_amount = reserved_amount + $2, version = version + 1, updated_at = now()
        WHERE id = $1
       RETURNING ${PROGRAM_COLUMNS}`,
      [programId, delta],
    );
    return toProgram(res.rows[0]);
  }

  /** Sets reserved_amount from the sum of outstanding reservations (used by reconciliation). */
  async recomputeReserved(tx: Queryable, programId: string): Promise<Program> {
    const res = await tx.query<ProgramRow>(
      `UPDATE programs p
          SET reserved_amount = COALESCE(
                (SELECT SUM(outstanding_program_amount) FROM reservations r WHERE r.program_id = p.id), 0),
              version = version + 1,
              updated_at = now()
        WHERE p.id = $1
       RETURNING ${PROGRAM_COLUMNS}`,
      [programId],
    );
    return toProgram(res.rows[0]);
  }

  async insertProgram(
    tx: Queryable,
    p: { id: string; currency: CurrencyCode; limit: Money; status: ProgramStatus; seq: number | null },
  ): Promise<Program> {
    const res = await tx.query<ProgramRow>(
      `INSERT INTO programs (id, currency, limit_amount, status, last_treasury_seq)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PROGRAM_COLUMNS}`,
      [p.id, p.currency, p.limit.amount.toString(), p.status, p.seq],
    );
    return toProgram(res.rows[0]);
  }

  async updateProgramTerms(
    tx: Queryable,
    id: string,
    terms: { currency: CurrencyCode; limit: Money; status: ProgramStatus; seq: number; reconciledAt?: Date },
  ): Promise<Program> {
    const res = await tx.query<ProgramRow>(
      `UPDATE programs
          SET currency = $2, limit_amount = $3, status = $4, last_treasury_seq = $5,
              last_reconciled_at = COALESCE($6, last_reconciled_at),
              version = version + 1, updated_at = now()
        WHERE id = $1
       RETURNING ${PROGRAM_COLUMNS}`,
      [id, terms.currency, terms.limit.amount.toString(), terms.status, terms.seq, terms.reconciledAt ?? null],
    );
    return toProgram(res.rows[0]);
  }

  async setTreasurySeq(tx: Queryable, id: string, seq: number): Promise<void> {
    await tx.query(`UPDATE programs SET last_treasury_seq = $2 WHERE id = $1`, [id, seq]);
  }

  /** Program currency is immutable once any reservation exists (amounts are denominated in it). */
  async hasReservations(q: Queryable, programId: string): Promise<boolean> {
    const res = await q.query(`SELECT 1 FROM reservations WHERE program_id = $1 LIMIT 1`, [programId]);
    return (res.rowCount ?? 0) > 0;
  }

  async findReservation(
    q: Queryable,
    programId: string,
    invoiceId: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<Reservation | null> {
    const res = await q.query<ReservationRow>(
      `${RESERVATION_SELECT} WHERE r.program_id = $1 AND r.invoice_id = $2 ${opts.forUpdate ? 'FOR UPDATE OF r' : ''}`,
      [programId, invoiceId],
    );
    return res.rows[0] ? toReservation(res.rows[0]) : null;
  }

  /** Open reservations plus any reservation for the given invoices, locked, for reconciliation. */
  async lockReservationsForReconciliation(
    tx: Queryable,
    programId: string,
    invoiceIds: string[],
  ): Promise<Reservation[]> {
    const res = await tx.query<ReservationRow>(
      `${RESERVATION_SELECT}
        WHERE r.program_id = $1
          AND (r.status IN ('RESERVED', 'PARTIALLY_RELEASED') OR r.invoice_id = ANY($2))
        ORDER BY r.id
        FOR UPDATE OF r`,
      [programId, invoiceIds],
    );
    return res.rows.map(toReservation);
  }

  async listReservations(
    q: Queryable,
    programId: string,
    opts: { status?: ReservationStatus; cursor?: number; order: SortOrder; limit: number },
  ): Promise<Reservation[]> {
    const params: unknown[] = [programId];
    let where = 'r.program_id = $1';
    if (opts.status) {
      params.push(opts.status);
      where += ` AND r.status = $${params.length}`;
    }
    if (opts.cursor !== undefined) {
      params.push(opts.cursor);
      where += ` AND r.seq ${opts.order === 'desc' ? '<' : '>'} $${params.length}`;
    }
    params.push(opts.limit);
    const res = await q.query<ReservationRow>(
      `${RESERVATION_SELECT} WHERE ${where} ORDER BY r.seq ${opts.order === 'desc' ? 'DESC' : 'ASC'} LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(toReservation);
  }

  async insertReservation(
    tx: Queryable,
    r: {
      programId: string;
      invoiceId: string;
      invoiceAmount: Money;
      programAmount: Money;
      fxRate: string;
      fxRateSource: string;
      fxRateAt: Date;
      source: ReservationSource;
      createdBy: string;
      /** Defaults to now(). Reconciliation-created rows use the snapshot's asOf instead. */
      lastLocalChangeAt?: Date;
    },
  ): Promise<Reservation> {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO reservations (
         id, program_id, invoice_id, status,
         invoice_currency, invoice_amount, outstanding_invoice_amount,
         program_amount, outstanding_program_amount,
         fx_rate, fx_rate_source, fx_rate_at, source, created_by, last_local_change_at)
       VALUES ($1, $2, $3, 'RESERVED', $4, $5, $5, $6, $6, $7, $8, $9, $10, $11, COALESCE($12, now()))`,
      [
        id,
        r.programId,
        r.invoiceId,
        r.invoiceAmount.currency,
        r.invoiceAmount.amount.toString(),
        r.programAmount.amount.toString(),
        r.fxRate,
        r.fxRateSource,
        r.fxRateAt,
        r.source,
        r.createdBy,
        r.lastLocalChangeAt ?? null,
      ],
    );
    return (await this.findReservation(tx, r.programId, r.invoiceId))!;
  }

  /**
   * @param localChange true for API / incremental-event changes (moves the reconciliation
   *   watermark), false for reconciliation adjustments.
   */
  async updateReservationState(
    tx: Queryable,
    id: string,
    s: { status: ReservationStatus; outstandingInvoice: Money; outstandingProgram: Money; localChange: boolean },
  ): Promise<void> {
    await tx.query(
      `UPDATE reservations
          SET status = $2,
              outstanding_invoice_amount = $3,
              outstanding_program_amount = $4,
              updated_at = now(),
              last_local_change_at = CASE WHEN $5 THEN now() ELSE last_local_change_at END,
              closed_at = CASE WHEN $2 IN ('RELEASED', 'CANCELLED') THEN COALESCE(closed_at, now()) ELSE NULL END
        WHERE id = $1`,
      [id, s.status, s.outstandingInvoice.amount.toString(), s.outstandingProgram.amount.toString(), s.localChange],
    );
  }

  async insertLedger(tx: Queryable, e: LedgerEntryInput): Promise<void> {
    await tx.query(
      `INSERT INTO ledger_entries (
         program_id, reservation_id, type, reserved_delta, limit_delta,
         reserved_after, limit_after, actor, correlation_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.program.id,
        e.reservationId ?? null,
        e.type,
        e.reservedDelta,
        e.limitDelta ?? '0',
        e.program.reserved.amount.toString(),
        e.program.limit.amount.toString(),
        e.actor,
        e.correlationId ?? null,
        e.details ? JSON.stringify(e.details) : null,
      ],
    );
  }

  async listLedger(q: Queryable, programId: string, opts: { cursor?: number; order: SortOrder; limit: number }) {
    const desc = opts.order === 'desc';
    const params: unknown[] = [programId, opts.limit];
    let where = 'program_id = $1';
    if (opts.cursor !== undefined) {
      params.push(opts.cursor);
      where += ` AND id ${desc ? '<' : '>'} $3`;
    }
    const res = await q.query<{
      id: string;
      reservation_id: string | null;
      type: LedgerType;
      reserved_delta: string;
      limit_delta: string;
      reserved_after: string;
      limit_after: string;
      actor: string;
      correlation_id: string | null;
      details: Record<string, unknown> | null;
      created_at: Date;
    }>(`SELECT * FROM ledger_entries WHERE ${where} ORDER BY id ${desc ? 'DESC' : 'ASC'} LIMIT $2`, params);
    return res.rows;
  }

  /**
   * Publishes a capacity change: an outbox row (relayed to Kafka after commit) and a
   * pg_notify for SSE subscribers. Both only become visible if the transaction commits.
   */
  async recordCapacityChange(tx: Queryable, program: Program, cause: string, topic: string): Promise<void> {
    const event = {
      type: 'CAPACITY_CHANGED',
      eventId: randomUUID(),
      programId: program.id,
      version: program.version,
      currency: program.currency,
      limit: program.limit.toString(),
      reserved: program.reserved.toString(),
      available: availableOf(program),
      status: program.status,
      cause,
      occurredAt: new Date().toISOString(),
    };
    await tx.query(`INSERT INTO outbox (topic, message_key, payload) VALUES ($1, $2, $3)`, [
      topic,
      program.id,
      JSON.stringify(event),
    ]);
    await tx.query(`SELECT pg_notify('capacity_changed', $1)`, [
      JSON.stringify({ programId: program.id, version: program.version }),
    ]);
  }
}
