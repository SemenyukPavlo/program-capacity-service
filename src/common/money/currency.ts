import { Errors } from '../errors/domain-error';

/**
 * Supported ISO 4217 currencies and their minor units (number of decimal places).
 * Deliberately a whitelist: accepting an arbitrary 3-letter code would let a typo
 * ("USS") create a program or reservation nobody can convert.
 */
const MINOR_UNITS = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CHF: 2,
  AED: 2,
  SAR: 2,
  SGD: 2,
  CNY: 2,
  INR: 2,
  JPY: 0,
  KWD: 3,
  BHD: 3,
} as const;

export type CurrencyCode = keyof typeof MINOR_UNITS;

export const SUPPORTED_CURRENCIES = Object.keys(MINOR_UNITS) as CurrencyCode[];

export function isCurrency(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(MINOR_UNITS, value);
}

export function toCurrency(value: string): CurrencyCode {
  if (!isCurrency(value)) {
    throw Errors.validation('UNSUPPORTED_CURRENCY', `Unsupported currency: ${value}`, {
      supported: SUPPORTED_CURRENCIES,
    });
  }
  return value;
}

export function minorUnits(currency: CurrencyCode): number {
  return MINOR_UNITS[currency];
}
