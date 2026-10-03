import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { APP_CONFIG, AppConfig } from '../config/config';
import { CurrencyCode } from '../common/money/currency';
import { Money, MoneyDecimal } from '../common/money/money';
import { Errors } from '../common/errors/domain-error';
import { FxRateProvider } from './fx-rate.provider';

/** Precision the rate is stored with (NUMERIC(24,12)); the stored rate is the one used to compute. */
const RATE_DECIMALS = 12;
const MAX_AMOUNT = new MoneyDecimal('1e18');

export interface Conversion {
  converted: Money;
  rate: Decimal;
  source: string;
  asOf: Date;
}

@Injectable()
export class FxService {
  constructor(
    private readonly provider: FxRateProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Converts an invoice amount into program currency for a reservation.
   * Rounds UP so the program never reserves less than the invoice is worth.
   */
  async convertForReservation(amount: Money, to: CurrencyCode, now = new Date()): Promise<Conversion> {
    if (amount.currency === to) {
      return { converted: amount, rate: new MoneyDecimal(1), source: 'identity', asOf: now };
    }
    const quote = await this.provider.getRate(amount.currency, to);
    if (!quote) {
      throw Errors.unprocessable('UNSUPPORTED_CURRENCY_PAIR', `No FX rate available for ${amount.currency}->${to}`, {
        from: amount.currency,
        to,
      });
    }
    const ageSec = (now.getTime() - quote.asOf.getTime()) / 1000;
    if (ageSec > this.config.FX_MAX_RATE_AGE_SEC) {
      throw Errors.unavailable('FX_RATE_STALE', `FX rate ${amount.currency}->${to} is stale`, {
        rateAsOf: quote.asOf.toISOString(),
        maxAgeSec: this.config.FX_MAX_RATE_AGE_SEC,
      });
    }
    const rate = new MoneyDecimal(quote.rate).toDecimalPlaces(RATE_DECIMALS, MoneyDecimal.ROUND_HALF_EVEN);
    const converted = Money.fromProduct(amount.amount, rate, to, 'UP');
    // Same bound as client input (18 integer digits, the range of NUMERIC(24,6)).
    if (converted.amount.greaterThanOrEqualTo(MAX_AMOUNT)) {
      throw Errors.unprocessable('AMOUNT_OUT_OF_RANGE', `Converted amount exceeds the supported range`, {
        converted: converted.toString(),
        currency: to,
      });
    }
    return {
      converted,
      rate,
      source: quote.source,
      asOf: quote.asOf,
    };
  }
}
