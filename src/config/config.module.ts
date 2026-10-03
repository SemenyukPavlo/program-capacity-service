import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from './config';

/** Provides the validated configuration (`APP_CONFIG`) to every module. */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return { module: ConfigModule, providers: [{ provide: APP_CONFIG, useValue: config }], exports: [APP_CONFIG] };
  }
}
