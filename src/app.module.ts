import { DynamicModule, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { randomUUID } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { AppConfig } from './config/config';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { ObservabilityModule } from './observability/observability.module';
import { HttpMetricsMiddleware } from './observability/http-metrics.middleware';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/auth.guard';
import { CapacityModule } from './capacity/capacity.module';
import { TreasuryModule } from './treasury/treasury.module';
import { HealthModule } from './health/health.module';
import { ProblemDetailsFilter } from './common/http/problem-details.filter';
import { ClientThrottlerGuard } from './common/http/client-throttler.guard';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Composition root: infrastructure modules, feature modules and app-wide guards/pipes/filters. */
@Module({})
export class AppModule implements NestModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.LOG_LEVEL,
            // Correlation id: honour a sane inbound X-Request-Id, otherwise generate one.
            genReqId: (req: IncomingMessage, res) => {
              const inbound = req.headers['x-request-id'];
              const value = typeof inbound === 'string' && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
              res.setHeader('X-Request-Id', value);
              return value;
            },
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
            transport:
              config.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
          },
        }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: config.RATE_LIMIT_PER_MINUTE }]),
        DatabaseModule,
        ObservabilityModule,
        AuthModule,
        CapacityModule,
        TreasuryModule,
        HealthModule,
      ],
      providers: [
        // Registered together here so the order is explicit: authenticate first, then rate-limit per client.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: ClientThrottlerGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('{*splat}');
  }
}
