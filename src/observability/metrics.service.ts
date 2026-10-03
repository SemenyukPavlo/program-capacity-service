import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  readonly capacityOperations = new Counter({
    name: 'capacity_operations_total',
    help: 'Reservation/release/cancel operations by outcome',
    labelNames: ['operation', 'outcome'],
    registers: [this.registry],
  });

  readonly kafkaMessages = new Counter({
    name: 'kafka_messages_total',
    help: 'Consumed Kafka messages by outcome (applied, duplicate, stale, dead_lettered, ...)',
    labelNames: ['topic', 'type', 'outcome'],
    registers: [this.registry],
  });

  readonly treasurySeqGaps = new Counter({
    name: 'treasury_sequence_gaps_total',
    help: 'Incremental treasury events that skipped one or more sequence numbers',
    registers: [this.registry],
  });

  readonly reconciliationRuns = new Counter({
    name: 'reconciliation_runs_total',
    help: 'Reconciliation snapshots processed by status',
    labelNames: ['status'],
    registers: [this.registry],
  });

  readonly reconciliationDiscrepancies = new Counter({
    name: 'reconciliation_discrepancies_total',
    help: 'Reservation-level discrepancies found by reconciliation',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  readonly reconciliationDrift = new Gauge({
    name: 'reconciliation_last_drift_amount',
    help: 'Absolute change of reserved amount applied by the last reconciliation, per program (program currency)',
    labelNames: ['program_id'],
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Outbox events published to Kafka',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
