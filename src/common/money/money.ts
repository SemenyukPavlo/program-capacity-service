import Decimal from 'decimal.js';
import { Errors } from '../errors/domain-error';
import { CurrencyCode, minorUnits } from './currency';

// Plain decimal notation only: no exponent, sign, whitespace, or leading '+'.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,12})?$/;

// Dedicated Decimal constructor so global configuration elsewhere cannot affect money maths.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export type Rounding = 'UP' | 'DOWN';

/**
 * Immutable monetary amount. Amounts are always non-negative here: debits and credits are
 * expressed by the operation (reserve/release), never by a sign.
 */
export class Money {
  private constructor(
    readonly amount: Decimal,
    readonly currency: CurrencyCode,
  ) {}

  /** Strictly parses client/Kafka input. Rejects more decimals than the currency allows. */
  static parse(raw: string, currency: CurrencyCode): Money {
    if (typeof raw !== 'string' || !AMOUNT_PATTERN.test(raw)) {
      throw Errors.validation('INVALID_AMOUNT', `Invalid amount "${String(raw)}": expected a decimal string`);
    }
    const amount = new D(raw);
    if (amount.decimalPlaces() > minorUnits(currency)) {
      throw Errors.validation(
        'INVALID_AMOUNT_SCALE',
        `${currency} supports at most ${minorUnits(currency)} decimal places, got "${raw}"`,
      );
    }
    return new Money(amount, currency);
  }

  /** Builds from a trusted value (e.g. a NUMERIC column), which may carry trailing zeros. */
  static of(value: Decimal.Value, currency: CurrencyCode): Money {
    const amount = new D(value);
    if (!amount.isFinite() || amount.isNegative()) {
      throw new Error(`Invalid money value: ${String(value)}`);
    }
    if (amount.decimalPlaces() > minorUnits(currency)) {
      throw new Error(`Value ${amount.toString()} exceeds ${currency} precision`);
    }
    return new Money(amount, currency);
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(new D(0), currency);
  }

  /** Multiplies and rounds to the target currency's minor units in the given direction. */
  static fromProduct(value: Decimal.Value, factor: Decimal.Value, currency: CurrencyCode, rounding: Rounding): Money {
    const exact = new D(value).times(factor);
    const mode = rounding === 'UP' ? D.ROUND_UP : D.ROUND_DOWN;
    return new Money(exact.toDecimalPlaces(minorUnits(currency), mode), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.amount.minus(other.amount);
    if (result.isNegative()) {
      throw new Error(`Money subtraction would go negative: ${this.toString()} - ${other.toString()}`);
    }
    return new Money(result, this.currency);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.greaterThan(0);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount.greaterThan(other.amount);
  }

  /** Canonical string with exactly the currency's minor units, e.g. "1000.50", "1500" for JPY. */
  toString(): string {
    return this.amount.toFixed(minorUnits(this.currency));
  }

  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new Error(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}

/** Formats a possibly-negative decimal (e.g. availability) with the currency's minor units. */
export function formatSigned(value: Decimal.Value, currency: CurrencyCode): string {
  return new D(value).toFixed(minorUnits(currency));
}

export { D as MoneyDecimal };
