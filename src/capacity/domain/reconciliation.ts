import { Money } from '../../common/money/money';

export interface LocalReservationView {
  id: string;
  invoiceId: string;
  outstandingProgram: Money;
  /** Last change made by this service (not by reconciliation). */
  lastLocalChangeAt: Date;
}

export interface SnapshotReservation {
  invoiceId: string;
  /** Outstanding amount in program currency, as known by treasury. */
  outstanding: Money;
}

export type DiscrepancyReason =
  /** Treasury has an open reservation we don't know about. */
  | 'MISSING_LOCALLY'
  /** We have an open reservation treasury doesn't list, and it predates the snapshot. */
  | 'MISSING_IN_TREASURY'
  /** Both sides know the invoice but disagree on the outstanding amount. */
  | 'AMOUNT_MISMATCH';

export interface Adjustment {
  reservationId: string;
  invoiceId: string;
  from: Money;
  to: Money;
  reason: DiscrepancyReason;
}

export interface Creation {
  invoiceId: string;
  amount: Money;
  reason: 'MISSING_LOCALLY';
}

export interface KeptLocal {
  invoiceId: string;
  /** Local state changed after the snapshot was taken, so the snapshot cannot be newer. */
  reason: 'LOCAL_CHANGE_AFTER_SNAPSHOT';
}

export interface ReconciliationPlan {
  adjustments: Adjustment[];
  creations: Creation[];
  kept: KeptLocal[];
}

/**
 * Diffs local reservations against a treasury snapshot taken at `asOf`.
 *
 * Treasury wins for everything it could have known about at `asOf`. Any reservation this
 * service touched after `asOf` is left alone: the snapshot simply predates that change and the
 * next snapshot will include it. This relies on the two clocks being reasonably in sync; see
 * README ("Reconciliation watermark") for the echo-watermark alternative.
 *
 * `local` must contain every open local reservation plus any local reservation whose invoice
 * appears in the snapshot (so released ones can be re-opened if treasury says so).
 */
export function planReconciliation(
  local: LocalReservationView[],
  snapshot: SnapshotReservation[],
  asOf: Date,
): ReconciliationPlan {
  const plan: ReconciliationPlan = { adjustments: [], creations: [], kept: [] };
  const byInvoice = new Map(local.map((r) => [r.invoiceId, r]));
  const seen = new Set<string>();

  for (const item of snapshot) {
    seen.add(item.invoiceId);
    const mine = byInvoice.get(item.invoiceId);
    if (!mine) {
      if (item.outstanding.isPositive()) {
        plan.creations.push({ invoiceId: item.invoiceId, amount: item.outstanding, reason: 'MISSING_LOCALLY' });
      }
      continue;
    }
    if (mine.outstandingProgram.equals(item.outstanding)) continue;
    if (mine.lastLocalChangeAt > asOf) {
      plan.kept.push({ invoiceId: mine.invoiceId, reason: 'LOCAL_CHANGE_AFTER_SNAPSHOT' });
      continue;
    }
    plan.adjustments.push({
      reservationId: mine.id,
      invoiceId: mine.invoiceId,
      from: mine.outstandingProgram,
      to: item.outstanding,
      reason: 'AMOUNT_MISMATCH',
    });
  }

  for (const mine of local) {
    if (seen.has(mine.invoiceId) || mine.outstandingProgram.isZero()) continue;
    if (mine.lastLocalChangeAt > asOf) {
      plan.kept.push({ invoiceId: mine.invoiceId, reason: 'LOCAL_CHANGE_AFTER_SNAPSHOT' });
      continue;
    }
    plan.adjustments.push({
      reservationId: mine.id,
      invoiceId: mine.invoiceId,
      from: mine.outstandingProgram,
      to: Money.zero(mine.outstandingProgram.currency),
      reason: 'MISSING_IN_TREASURY',
    });
  }

  return plan;
}
