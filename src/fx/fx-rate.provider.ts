import Decimal from 'decimal.js';
import { CurrencyCode } from '../common/money/currency';

export interface FxQuote {
  from: CurrencyCode;
  to: CurrencyCode;
  /** Units of `to` per one unit of `from`. */
  rate: Decimal;
  source: string;
  asOf: Date;
}

/**
 * Port for FX rates. Production would back this with the treasury rate feed or a market data
 * vendor; locally a static table is used. Returns `null` when the pair is not available.
 */
export abstract class FxRateProvider {
  abstract getRate(from: CurrencyCode, to: CurrencyCode): Promise<FxQuote | null>;
}
