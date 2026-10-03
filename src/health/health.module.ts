import { Module } from '@nestjs/common';
import { TreasuryModule } from '../treasury/treasury.module';
import { HealthController } from './health.controller';

@Module({
  imports: [TreasuryModule],
  controllers: [HealthController],
})
export class HealthModule {}
