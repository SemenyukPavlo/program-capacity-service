import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import { MetricsService } from '../observability/metrics.service';
import { KafkaService } from './kafka.service';

const BATCH_SIZE = 100;
const IDLE_POLL_MS = 500;

/**
 * Transactional outbox relay: publishes rows written in the same transaction as the capacity
 * change, so an event is emitted if and only if the change committed (no dual-write problem).
 * Delivery is at-least-once; consumers de-duplicate by eventId and order by `version`.
 * FOR UPDATE SKIP LOCKED lets several replicas relay concurrently without double-sending a row.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly db: DatabaseService,
    private readonly kafka: KafkaService,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.KAFKA_ENABLED) return;
    this.running = true;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const published = await this.publishBatch();
        if (published === 0) await sleep(IDLE_POLL_MS);
      } catch (err) {
        this.logger.error({ err }, 'Outbox relay failed; retrying');
        await sleep(2000);
      }
    }
  }

  async publishBatch(): Promise<number> {
    const producer = await this.kafka.getProducer();
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; topic: string; message_key: string; payload: unknown }>(
        `SELECT id, topic, message_key, payload FROM outbox
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED`,
      );
      if (rows.length === 0) return 0;

      const byTopic = new Map<string, { key: string; value: string }[]>();
      for (const r of rows) {
        const list = byTopic.get(r.topic) ?? [];
        list.push({ key: r.message_key, value: JSON.stringify(r.payload) });
        byTopic.set(r.topic, list);
      }
      await producer.sendBatch({ topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })) });
      await tx.query(`UPDATE outbox SET published_at = now() WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
      this.metrics.outboxPublished.inc(rows.length);
      return rows.length;
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
