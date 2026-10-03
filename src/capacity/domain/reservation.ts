import { Errors } from '../../common/errors/domain-error';
import { Money, MoneyDecimal } from '../../common/money/money';

export type ReservationStatus = 'RESERVED' | 'PARTIALLY_RELEASED' | 'RELEASED' | 'CANCELLED';
export type ReservationSource = 'API' | 'TREASURY' | 'RECONCILIATION';

export const OPEN_STATUSES: readonly ReservationStatus[] = ['RESERVED', 'PARTIALLY_RELEASED'];

export interface ReservationAmounts {
  status: ReservationStatus;
  invoiceAmount: Money;
  outstandingInvoice: Money;
  programAmount: Money;
  outstandingProgram: Money;
}

export interface ReleasePlan {
  /** True when nothing changes (idempotent repeat of a full release). */
  noop: boolean;
  invoiceDelta: Money;
  programDelta: Money;
  status: ReservationStatus;
}

/**
 * Plans a (partial or full) repayment.
 *
 * - `amount` omitted = release everything outstanding; repeating it on a RELEASED reservation is a no-op.
 * - Partial amounts are in invoice currency and converted proportionally to the *outstanding*
 *   program amount (i.e. at the rate locked at reservation time, never today's rate). Partial
 *   program deltas round DOWN so capacity is never released early; the final release takes the
 *   exact remainder, so rounding never leaves dust behind.
 */
export function planRelease(r: ReservationAmounts, amount?: Money): ReleasePlan {
  if (r.status === 'CANCELLED') {
    throw Errors.conflict('INVALID_STATE_TRANSITION', 'Cannot release a cancelled reservation', {
      reservationStatus: r.status,
    });
  }

  if (amount === undefined) {
    if (r.status === 'RELEASED') {
      return {
        noop: true,
        invoiceDelta: Money.zero(r.invoiceAmount.currency),
        programDelta: Money.zero(r.programAmount.currency),
        status: r.status,
      };
    }
    return { noop: false, invoiceDelta: r.outstandingInvoice, programDelta: r.outstandingProgram, status: 'RELEASED' };
  }

  if (amount.currency !== r.invoiceAmount.currency) {
    throw Errors.unprocessable(
      'CURRENCY_MISMATCH',
      `Release must be in invoice currency ${r.invoiceAmount.currency}, got ${amount.currency}`,
    );
  }
  if (!amount.isPositive()) {
    throw Errors.validation('INVALID_AMOUNT', 'Release amount must be greater than zero');
  }
  if (amount.greaterThan(r.outstandingInvoice)) {
    throw Errors.unprocessable('RELEASE_EXCEEDS_OUTSTANDING', 'Release amount exceeds outstanding amount', {
      outstanding: r.outstandingInvoice.toString(),
      requested: amount.toString(),
      currency: amount.currency,
    });
  }

  if (amount.equals(r.outstandingInvoice)) {
    return { noop: false, invoiceDelta: amount, programDelta: r.outstandingProgram, status: 'RELEASED' };
  }

  const ratio = r.outstandingProgram.amount.div(r.outstandingInvoice.amount);
  const programDelta = Money.fromProduct(amount.amount, ratio, r.programAmount.currency, 'DOWN');
  return { noop: false, invoiceDelta: amount, programDelta, status: 'PARTIALLY_RELEASED' };
}

/** Cancellation = invoice withdrawn before any repayment. Repeating it is a no-op. */
export function planCancel(r: ReservationAmounts): ReleasePlan {
  if (r.status === 'CANCELLED') {
    return {
      noop: true,
      invoiceDelta: Money.zero(r.invoiceAmount.currency),
      programDelta: Money.zero(r.programAmount.currency),
      status: r.status,
    };
  }
  if (r.status !== 'RESERVED') {
    throw Errors.conflict('INVALID_STATE_TRANSITION', `Cannot cancel a reservation in status ${r.status}`, {
      reservationStatus: r.status,
    });
  }
  return { noop: false, invoiceDelta: r.outstandingInvoice, programDelta: r.outstandingProgram, status: 'CANCELLED' };
}

/**
 * State after reconciliation forces the outstanding program amount to `target`.
 * Reconciliation is the one path allowed to bypass the normal state machine (including
 * re-opening a released reservation), because treasury is authoritative; every such
 * change is recorded as a discrepancy and a RECON_ADJUSTMENT ledger entry.
 */
export function applyReconciledOutstanding(
  r: ReservationAmounts,
  target: Money,
): { status: ReservationStatus; outstandingInvoice: Money; outstandingProgram: Money } {
  if (target.isZero()) {
    return {
      status: r.status === 'CANCELLED' ? 'CANCELLED' : 'RELEASED',
      outstandingInvoice: Money.zero(r.invoiceAmount.currency),
      outstandingProgram: target,
    };
  }
  if (!r.programAmount.greaterThan(target)) {
    return { status: 'RESERVED', outstandingInvoice: r.invoiceAmount, outstandingProgram: target };
  }
  const ratio = new MoneyDecimal(r.invoiceAmount.amount).div(r.programAmount.amount);
  return {
    status: 'PARTIALLY_RELEASED',
    outstandingInvoice: Money.fromProduct(target.amount, ratio, r.invoiceAmount.currency, 'DOWN'),
    outstandingProgram: target,
  };
}
