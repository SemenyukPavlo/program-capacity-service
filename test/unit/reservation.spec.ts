import fc from 'fast-check';
import { Money } from '../../src/common/money/money';
import {
  applyReconciledOutstanding,
  planCancel,
  planRelease,
  ReservationAmounts,
  ReservationStatus,
} from '../../src/capacity/domain/reservation';

function reservation(overrides: Partial<ReservationAmounts> = {}): ReservationAmounts {
  return {
    status: 'RESERVED',
    invoiceAmount: Money.parse('100000.00', 'EUR'),
    outstandingInvoice: Money.parse('100000.00', 'EUR'),
    programAmount: Money.parse('108000.00', 'USD'),
    outstandingProgram: Money.parse('108000.00', 'USD'),
    ...overrides,
  };
}

describe('planRelease', () => {
  it('full release returns the stored program amount (no re-conversion)', () => {
    const plan = planRelease(reservation());
    expect(plan).toMatchObject({ noop: false, status: 'RELEASED' });
    expect(plan.programDelta.toString()).toBe('108000.00');
  });

  it('repeating a full release is a no-op', () => {
    const plan = planRelease(reservation({ status: 'RELEASED' }));
    expect(plan.noop).toBe(true);
    expect(plan.programDelta.isZero()).toBe(true);
  });

  it('partial release converts proportionally at the locked rate', () => {
    const plan = planRelease(reservation(), Money.parse('40000.00', 'EUR'));
    expect(plan.status).toBe('PARTIALLY_RELEASED');
    expect(plan.programDelta.toString()).toBe('43200.00');
  });

  it('partial release rounds DOWN, final release takes the exact remainder', () => {
    const r = reservation({
      invoiceAmount: Money.parse('3.00', 'EUR'),
      outstandingInvoice: Money.parse('3.00', 'EUR'),
      programAmount: Money.parse('1.00', 'USD'),
      outstandingProgram: Money.parse('1.00', 'USD'),
    });
    const first = planRelease(r, Money.parse('1.00', 'EUR'));
    expect(first.programDelta.toString()).toBe('0.33');
  });

  it.each([
    [{ status: 'CANCELLED' as ReservationStatus }, undefined, 'INVALID_STATE_TRANSITION'],
    [{}, Money.parse('100000.01', 'EUR'), 'RELEASE_EXCEEDS_OUTSTANDING'],
    [{}, Money.parse('10.00', 'USD'), 'CURRENCY_MISMATCH'],
    [{}, Money.parse('0', 'EUR'), 'INVALID_AMOUNT'],
    [
      {
        status: 'RELEASED' as ReservationStatus,
        outstandingInvoice: Money.zero('EUR'),
        outstandingProgram: Money.zero('USD'),
      },
      Money.parse('1.00', 'EUR'),
      'RELEASE_EXCEEDS_OUTSTANDING',
    ],
  ])('rejects %o / %s with %s', (overrides, amount, code) => {
    expect(() => planRelease(reservation(overrides), amount)).toThrow(expect.objectContaining({ code }));
  });

  it('property: any sequence of partial releases ending in a full release releases exactly the program amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }), // invoice amount in cents
        fc.integer({ min: 1, max: 30_000 }), // rate * 10_000
        fc.array(fc.integer({ min: 1, max: 1000 }), { maxLength: 8 }), // release weights
        (invoiceCents, rate4, weights) => {
          const invoice = Money.parse((invoiceCents / 100).toFixed(2), 'EUR');
          const program = Money.fromProduct(invoice.amount, rate4 / 10_000, 'JPY', 'UP');
          if (!program.isPositive()) return;
          let r = reservation({
            invoiceAmount: invoice,
            outstandingInvoice: invoice,
            programAmount: program,
            outstandingProgram: program,
          });
          let released = Money.zero('JPY');
          for (const w of weights) {
            const cents = Math.floor((Number(r.outstandingInvoice.amount) * 100 * w) / 2000);
            if (cents <= 0 || cents >= Math.round(Number(r.outstandingInvoice.amount) * 100)) continue;
            const plan = planRelease(r, Money.parse((cents / 100).toFixed(2), 'EUR'));
            released = released.add(plan.programDelta);
            r = {
              ...r,
              status: plan.status,
              outstandingInvoice: r.outstandingInvoice.subtract(plan.invoiceDelta),
              outstandingProgram: r.outstandingProgram.subtract(plan.programDelta),
            };
          }
          const final = planRelease(r);
          released = released.add(final.programDelta);
          expect(released.equals(program)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('planCancel', () => {
  it('cancels an untouched reservation', () => {
    expect(planCancel(reservation())).toMatchObject({ noop: false, status: 'CANCELLED' });
  });

  it('is idempotent', () => {
    expect(planCancel(reservation({ status: 'CANCELLED' })).noop).toBe(true);
  });

  it.each(['PARTIALLY_RELEASED', 'RELEASED'] as ReservationStatus[])('refuses to cancel %s', (status) => {
    expect(() => planCancel(reservation({ status }))).toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
  });
});

describe('applyReconciledOutstanding', () => {
  it('zero closes the reservation', () => {
    expect(applyReconciledOutstanding(reservation(), Money.zero('USD')).status).toBe('RELEASED');
  });

  it('partial target derives the invoice outstanding proportionally', () => {
    const next = applyReconciledOutstanding(reservation(), Money.parse('54000.00', 'USD'));
    expect(next.status).toBe('PARTIALLY_RELEASED');
    expect(next.outstandingInvoice.toString()).toBe('50000.00');
  });

  it('re-opens a released reservation when treasury says it is outstanding', () => {
    const next = applyReconciledOutstanding(
      reservation({ status: 'RELEASED', outstandingInvoice: Money.zero('EUR'), outstandingProgram: Money.zero('USD') }),
      Money.parse('108000.00', 'USD'),
    );
    expect(next).toMatchObject({ status: 'RESERVED' });
    expect(next.outstandingInvoice.toString()).toBe('100000.00');
  });
});
