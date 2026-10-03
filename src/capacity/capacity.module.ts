import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { CapacityController } from './capacity.controller';
import { CapacityRepository } from './capacity.repository';
import { CapacityService } from './capacity.service';
import { CapacityStreamService } from './capacity-stream.service';
import { IdempotencyService } from './idempotency.service';

/** Reservations, releases and capacity reads (REST + SSE). */
@Module({
  imports: [FxModule],
  controllers: [CapacityController],
  providers: [CapacityRepository, CapacityService, IdempotencyService, CapacityStreamService],
  exports: [CapacityRepository, CapacityService],
})
export class CapacityModule {}
