import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { FxRateProvider } from './fx-rate.provider';
import { StaticFxRateProvider } from './static-fx-rate.provider';
import { FxService } from './fx.service';

@Module({
  providers: [
    // Swap this binding for a real rate-feed adapter in production.
    {
      provide: FxRateProvider,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new StaticFxRateProvider(config.FX_STATIC_RATES),
    },
    FxService,
  ],
  exports: [FxService],
})
export class FxModule {}
