import { Controller, Get, ServiceUnavailableException, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/auth.guard';
import { DatabaseService } from '../database/database.service';
import { TreasuryConsumer } from '../treasury/treasury.consumer';

/**
 * Liveness/readiness probes are the only unauthenticated routes: orchestrators (Kubernetes,
 * load balancers) call them without credentials, and they expose no business data.
 */
@ApiTags('health')
@Public()
@SkipThrottle()
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly consumer: TreasuryConsumer,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const checks: Record<string, 'up' | 'down'> = { database: 'up', kafkaConsumer: 'up' };
    try {
      await this.db.ping();
    } catch {
      checks.database = 'down';
    }
    if (!this.consumer.isHealthy()) checks.kafkaConsumer = 'down';
    if (Object.values(checks).includes('down')) throw new ServiceUnavailableException({ status: 'down', checks });
    return { status: 'up', checks };
  }
}
