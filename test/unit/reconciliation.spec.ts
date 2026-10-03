import { Money } from '../../src/common/money/money';
import { LocalReservationView, planReconciliation } from '../../src/capacity/domain/reconciliation';

const asOf = new Date('2026-01-01T12:00:00Z');
const before = new Date('2026-01-01T11:00:00Z');
const after = new Date('2026-01-01T12:00:01Z');
const usd = (v: string) => Money.parse(v, 'USD');

function local(invoiceId: string, outstanding: string, lastLocalChangeAt = before): LocalReservationView {
  return { id: `r-${invoiceId}`, invoiceId, outstandingProgram: usd(outstanding), lastLocalChangeAt };
}

describe('planReconciliation', () => {
  it('no changes when both sides agree', () => {
    const plan = planReconciliation([local('A', '100.00')], [{ invoiceId: 'A', outstanding: usd('100.00') }], asOf);
    expect(plan).toEqual({ adjustments: [], creations: [], kept: [] });
  });

  it('AMOUNT_MISMATCH: treasury wins', () => {
    const plan = planReconciliation([local('A', '100.00')], [{ invoiceId: 'A', outstanding: usd('60.00') }], asOf);
    expect(plan.adjustments).toEqual([
      expect.objectContaining({ invoiceId: 'A', reason: 'AMOUNT_MISMATCH', to: usd('60.00') }),
    ]);
  });

  it('MISSING_IN_TREASURY: local reservation older than snapshot is closed', () => {
    const plan = planReconciliation([local('A', '100.00')], [], asOf);
    expect(plan.adjustments).toEqual([expect.objectContaining({ invoiceId: 'A', reason: 'MISSING_IN_TREASURY' })]);
    expect(plan.adjustments[0].to.isZero()).toBe(true);
  });

  it('MISSING_LOCALLY: open treasury reservation is created', () => {
    const plan = planReconciliation([], [{ invoiceId: 'B', outstanding: usd('25.00') }], asOf);
    expect(plan.creations).toEqual([{ invoiceId: 'B', amount: usd('25.00'), reason: 'MISSING_LOCALLY' }]);
  });

  it('ignores zero-outstanding treasury rows unknown locally', () => {
    expect(planReconciliation([], [{ invoiceId: 'B', outstanding: usd('0') }], asOf).creations).toEqual([]);
  });

  it('keeps reservations created after asOf (in flight, not yet known to treasury)', () => {
    const plan = planReconciliation([local('NEW', '100.00', after)], [], asOf);
    expect(plan.adjustments).toEqual([]);
    expect(plan.kept).toEqual([{ invoiceId: 'NEW', reason: 'LOCAL_CHANGE_AFTER_SNAPSHOT' }]);
  });

  it('keeps local releases made after asOf even if treasury still shows them open', () => {
    const plan = planReconciliation(
      [local('A', '0.00', after)],
      [{ invoiceId: 'A', outstanding: usd('100.00') }],
      asOf,
    );
    expect(plan.adjustments).toEqual([]);
    expect(plan.kept).toHaveLength(1);
  });

  it('re-opens a locally released reservation when treasury (newer) still shows it open', () => {
    const plan = planReconciliation(
      [local('A', '0.00', before)],
      [{ invoiceId: 'A', outstanding: usd('100.00') }],
      asOf,
    );
    expect(plan.adjustments).toEqual([expect.objectContaining({ reason: 'AMOUNT_MISMATCH', to: usd('100.00') })]);
  });

  it('handles a mixed snapshot', () => {
    const plan = planReconciliation(
      [local('A', '1000.00'), local('B', '1000.00'), local('C', '1000.00'), local('E', '50.00', after)],
      [
        { invoiceId: 'A', outstanding: usd('1000.00') },
        { invoiceId: 'B', outstanding: usd('700.00') },
        { invoiceId: 'D', outstanding: usd('2500.00') },
      ],
      asOf,
    );
    expect(plan.adjustments.map((a) => [a.invoiceId, a.reason])).toEqual([
      ['B', 'AMOUNT_MISMATCH'],
      ['C', 'MISSING_IN_TREASURY'],
    ]);
    expect(plan.creations.map((c) => c.invoiceId)).toEqual(['D']);
    expect(plan.kept.map((k) => k.invoiceId)).toEqual(['E']);
  });
});
