import { MoneyDecimal } from '../common/money/money';
import { CurrencyCode, toCurrency } from '../common/money/currency';
import { FxQuote, FxRateProvider } from './fx-rate.provider';

type Decimal = InstanceType<typeof MoneyDecimal>;

const PIVOT: CurrencyCode = 'USD';

/**
 * Static rates parsed from config ("EUR:USD=1.08,GBP:USD=1.27"). Inverse pairs are derived,
 * and a missing pair is crossed through USD. Rates are treated as fresh (asOf = now) because
 * there is no feed to go stale; the staleness check in FxService still applies to real providers.
 */
export class StaticFxRateProvider extends FxRateProvider {
  private readonly rates = new Map<string, Decimal>();

  constructor(spec: string) {
    super();
    for (const entry of spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const match = /^([A-Z]{3}):([A-Z]{3})=(\d+(\.\d+)?)$/.exec(entry);
      if (!match) throw new Error(`Invalid FX_STATIC_RATES entry: "${entry}"`);
      const from = toCurrency(match[1]);
      const to = toCurrency(match[2]);
      const rate = new MoneyDecimal(match[3]);
      if (rate.lte(0)) throw new Error(`FX rate must be positive: "${entry}"`);
      this.rates.set(key(from, to), rate);
      if (!this.rates.has(key(to, from))) this.rates.set(key(to, from), new MoneyDecimal(1).div(rate));
    }
  }

  async getRate(from: CurrencyCode, to: CurrencyCode): Promise<FxQuote | null> {
    const rate = this.lookup(from, to);
    return rate ? { from, to, rate, source: 'static-config', asOf: new Date() } : null;
  }

  private lookup(from: CurrencyCode, to: CurrencyCode): Decimal | null {
    if (from === to) return new MoneyDecimal(1);
    const direct = this.rates.get(key(from, to));
    if (direct) return direct;
    const viaPivotA = this.rates.get(key(from, PIVOT));
    const viaPivotB = this.rates.get(key(PIVOT, to));
    return viaPivotA && viaPivotB ? viaPivotA.times(viaPivotB) : null;
  }
}

function key(from: CurrencyCode, to: CurrencyCode): string {
  return `${from}:${to}`;
}
