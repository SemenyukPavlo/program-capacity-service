import { availableOf, Program, Reservation } from './capacity.repository';

export interface CapacityView {
  programId: string;
  currency: string;
  limit: string;
  reserved: string;
  /** limit - reserved. May be negative if treasury lowered the limit below utilisation. */
  available: string;
  status: string;
  version: number;
  lastReconciledAt: string | null;
  updatedAt: string;
}

export interface ReservationView {
  id: string;
  programId: string;
  invoiceId: string;
  status: string;
  invoice: { currency: string; amount: string; outstanding: string };
  program: { currency: string; amount: string; outstanding: string };
  fx: { rate: string; source: string; asOf: string };
  source: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface ReservationResult {
  reservation: ReservationView;
  capacity: CapacityView;
}

export function toCapacityView(p: Program): CapacityView {
  return {
    programId: p.id,
    currency: p.currency,
    limit: p.limit.toString(),
    reserved: p.reserved.toString(),
    available: availableOf(p),
    status: p.status,
    version: p.version,
    lastReconciledAt: p.lastReconciledAt?.toISOString() ?? null,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toReservationView(r: Reservation): ReservationView {
  return {
    id: r.id,
    programId: r.programId,
    invoiceId: r.invoiceId,
    status: r.status,
    invoice: {
      currency: r.invoiceAmount.currency,
      amount: r.invoiceAmount.toString(),
      outstanding: r.outstandingInvoice.toString(),
    },
    program: {
      currency: r.programAmount.currency,
      amount: r.programAmount.toString(),
      outstanding: r.outstandingProgram.toString(),
    },
    fx: { rate: r.fxRate, source: r.fxRateSource, asOf: r.fxRateAt.toISOString() },
    source: r.source,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    closedAt: r.closedAt?.toISOString() ?? null,
  };
}
