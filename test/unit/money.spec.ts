import { DomainError } from '../../src/common/errors/domain-error';
import { toCurrency } from '../../src/common/money/currency';
import { formatSigned, Money } from '../../src/common/money/money';

describe('Money', () => {
  describe('parse', () => {
    it.each([
      ['100', 'USD', '100.00'],
      ['100.5', 'USD', '100.50'],
      ['0.01', 'USD', '0.01'],
      ['1500', 'JPY', '1500'],
      ['1.234', 'KWD', '1.234'],
      ['999999999999999999.99', 'USD', '999999999999999999.99'],
    ])('accepts %s %s', (raw, ccy, expected) => {
      expect(Money.parse(raw, toCurrency(ccy)).toString()).toBe(expected);
    });

    it.each(['1e5', '-1', '+1', ' 1', '1 ', '01', '1.', '.5', 'NaN', 'Infinity', '', '1,000.00', '0x10'])(
      'rejects malformed "%s"',
      (raw) => {
        expect(() => Money.parse(raw, 'USD')).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
      },
    );

    it('rejects non-string input (JSON numbers)', () => {
      expect(() => Money.parse(100 as unknown as string, 'USD')).toThrow(DomainError);
    });

    it.each([
      ['10.001', 'USD'],
      ['10.5', 'JPY'],
      ['1.2345', 'KWD'],
    ])('rejects %s %s for exceeding currency minor units', (raw, ccy) => {
      expect(() => Money.parse(raw, toCurrency(ccy))).toThrow(
        expect.objectContaining({ code: 'INVALID_AMOUNT_SCALE' }),
      );
    });

    it('does not suffer from binary floating point', () => {
      const sum = Money.parse('0.1', 'USD').add(Money.parse('0.2', 'USD'));
      expect(sum.equals(Money.parse('0.3', 'USD'))).toBe(true);
    });
  });

  it('accepts trusted DB values with trailing zeros', () => {
    expect(Money.of('100.000000', 'USD').toString()).toBe('100.00');
    expect(Money.of('1500.000000', 'JPY').toString()).toBe('1500');
  });

  it('refuses cross-currency arithmetic', () => {
    expect(() => Money.parse('1', 'USD').add(Money.parse('1', 'EUR'))).toThrow(/Currency mismatch/);
  });

  it('refuses to go negative', () => {
    expect(() => Money.parse('1', 'USD').subtract(Money.parse('2', 'USD'))).toThrow(/negative/);
  });

  it('rounds products in the requested direction to minor units', () => {
    expect(Money.fromProduct('100.00', '1.08333', 'USD', 'UP').toString()).toBe('108.34');
    expect(Money.fromProduct('100.00', '1.08333', 'USD', 'DOWN').toString()).toBe('108.33');
    expect(Money.fromProduct('100.00', '149.505', 'JPY', 'UP').toString()).toBe('14951');
  });

  it('formats signed availability', () => {
    expect(formatSigned('-250.5', 'USD')).toBe('-250.50');
  });

  it('rejects unsupported currencies', () => {
    expect(() => toCurrency('USS')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CURRENCY' }));
  });
});
