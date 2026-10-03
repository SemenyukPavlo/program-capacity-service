import { Module } from '@nestjs/common';
import { CapacityModule } from '../capacity/capacity.module';
import { KafkaService } from './kafka.service';
import { OutboxRelay } from './outbox.relay';
import { ReconciliationService } from './reconciliation.service';
import { TreasuryConsumer } from './treasury.consumer';
import { TreasuryHandler } from './treasury.handler';

/** Kafka integration with the treasury system: inbound events, reconciliation, DLQ and the outbox relay. */
@Module({
  imports: [CapacityModule],
  providers: [KafkaService, ReconciliationService, TreasuryHandler, TreasuryConsumer, OutboxRelay],
  exports: [TreasuryHandler, TreasuryConsumer],
})
export class TreasuryModule {}
