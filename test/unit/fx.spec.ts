import { AppConfig } from '../../src/config/config';
import { Money } from '../../src/common/money/money';
import { CurrencyCode } from '../../src/common/money/currency';
import { FxQuote, FxRateProvider } from '../../src/fx/fx-rate.provider';
import { FxService } from '../../src/fx/fx.service';
import { StaticFxRateProvider } from '../../src/fx/static-fx-rate.provider';

const config = { FX_MAX_RATE_AGE_SEC: 60 } as AppConfig;

describe('StaticFxRateProvider', () => {
  const provider = new StaticFxRateProvider('EUR:USD=1.08,USD:JPY=150');

  it('returns configured, inverse and cross rates', async () => {
    expect((await provider.getRate('EUR', 'USD'))!.rate.toString()).toBe('1.08');
    expect((await provider.getRate('USD', 'EUR'))!.rate.toFixed(6)).toBe('0.925926');
    expect((await provider.getRate('EUR', 'JPY'))!.rate.toString()).toBe('162');
  });

  it('returns null for unknown pairs', async () => {
    expect(await provider.getRate('GBP', 'USD')).toBeNull();
  });

  it('rejects malformed configuration', () => {
    expect(() => new StaticFxRateProvider('EUR-USD=1')).toThrow(/Invalid FX_STATIC_RATES/);
    expect(() => new StaticFxRateProvider('EUR:USD=0')).toThrow(/positive/);
  });
});

describe('FxService.convertForReservation', () => {
  const service = new FxService(new StaticFxRateProvider('EUR:USD=1.08,USD:JPY=149.505'), config);

  it('is identity for same currency', async () => {
    const r = await service.convertForReservation(Money.parse('10.00', 'USD'), 'USD');
    expect(r.converted.toString()).toBe('10.00');
    expect(r.rate.toString()).toBe('1');
  });

  it('converts and rounds UP so the program never under-reserves', async () => {
    const r = await service.convertForReservation(Money.parse('0.01', 'USD'), 'JPY');
    expect(r.converted.toString()).toBe('2'); // 1.49505 JPY -> 2
    const eur = await service.convertForReservation(Money.parse('100000.00', 'EUR'), 'USD');
    expect(eur.converted.toString()).toBe('108000.00');
  });

  it('fails with 422-type error for an unsupported pair', async () => {
    await expect(service.convertForReservation(Money.parse('1', 'GBP'), 'USD')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CURRENCY_PAIR',
      kind: 'UNPROCESSABLE',
    });
  });

  it('refuses a converted amount beyond the supported range', async () => {
    await expect(service.convertForReservation(Money.parse('10000000000000000', 'USD'), 'JPY')).rejects.toMatchObject({
      code: 'AMOUNT_OUT_OF_RANGE',
    });
  });

  it('refuses stale rates', async () => {
    class OldRates extends FxRateProvider {
      async getRate(from: CurrencyCode, to: CurrencyCode): Promise<FxQuote> {
        return {
          from,
          to,
          rate: Money.parse('1.1', 'USD').amount,
          source: 'feed',
          asOf: new Date(Date.now() - 3_600_000),
        };
      }
    }
    await expect(
      new FxService(new OldRates(), config).convertForReservation(Money.parse('1', 'EUR'), 'USD'),
    ).rejects.toMatchObject({
      code: 'FX_RATE_STALE',
    });
  });
});
