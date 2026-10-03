import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Consumer, KafkaMessage } from 'kafkajs';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import { MetricsService } from '../observability/metrics.service';
import { KafkaService } from './kafka.service';
import { IncomingMessage, PoisonMessageError, TreasuryHandler } from './treasury.handler';

const MAX_BACKOFF_MS = 30_000;

/**
 * Consumes treasury topics with manual offset commits:
 *   process (one DB transaction) -> commit offset.
 * A crash between the two re-delivers the message, which the handler de-duplicates by eventId,
 * giving effectively-once processing.
 *
 * Failure handling:
 *   - poison (invalid schema / rejected by domain rules) -> DLQ, then commit and move on;
 *   - transient (DB down, timeouts) -> retry the same message with capped exponential backoff.
 *     The partition is deliberately blocked meanwhile: skipping would break per-program ordering.
 */
@Injectable()
export class TreasuryConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TreasuryConsumer.name);
  private consumer?: Consumer;
  private stopping = false;
  private joined = false;

  constructor(
    private readonly kafka: KafkaService,
    private readonly handler: TreasuryHandler,
    private readonly db: DatabaseService,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  isHealthy(): boolean {
    return !this.config.KAFKA_ENABLED || this.joined;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.KAFKA_ENABLED) return;
    const consumer = this.kafka.kafka.consumer({
      groupId: this.config.KAFKA_GROUP_ID,
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
      // Snapshots can be large.
      maxBytesPerPartition: 10 * 1024 * 1024,
    });
    this.consumer = consumer;
    consumer.on(consumer.events.GROUP_JOIN, () => (this.joined = true));
    consumer.on(consumer.events.CRASH, ({ payload }) => {
      this.joined = false;
      this.logger.error({ err: payload.error, restart: payload.restart }, 'Kafka consumer crashed');
    });
    consumer.on(consumer.events.STOP, () => (this.joined = false));

    await consumer.connect();
    await consumer.subscribe({
      topics: [this.config.KAFKA_TOPIC_PROGRAM_EVENTS, this.config.KAFKA_TOPIC_RECONCILIATION],
      fromBeginning: true,
    });
    await consumer.run({
      autoCommit: false,
      partitionsConsumedConcurrently: 4,
      eachMessage: async ({ topic, partition, message, heartbeat }) => {
        await this.process({ topic, partition, message }, heartbeat);
        await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
      },
    });
    this.logger.log('Treasury consumer started');
  }

  private async process(
    m: { topic: string; partition: number; message: KafkaMessage },
    heartbeat: () => Promise<void>,
  ): Promise<void> {
    const raw: IncomingMessage = {
      topic: m.topic,
      partition: m.partition,
      offset: m.message.offset,
      key: m.message.key?.toString() ?? null,
      value: m.message.value,
    };

    for (let attempt = 1; ; attempt++) {
      try {
        await this.handler.handle(raw);
        return;
      } catch (err) {
        if (err instanceof PoisonMessageError) {
          await this.deadLetter(raw, m.message, err);
          return;
        }
        if (this.stopping) throw err; // leave uncommitted; redelivered after restart
        const delay = Math.min(MAX_BACKOFF_MS, 200 * 2 ** attempt);
        this.logger.error({ err, topic: raw.topic, offset: raw.offset, attempt, delay }, 'Transient failure, retrying');
        await new Promise((r) => setTimeout(r, delay));
        await heartbeat();
      }
    }
  }

  private async deadLetter(raw: IncomingMessage, message: KafkaMessage, err: PoisonMessageError): Promise<void> {
    this.logger.error(
      { topic: raw.topic, partition: raw.partition, offset: raw.offset, eventId: err.eventId, reason: err.message },
      'Poison message sent to DLQ',
    );
    const producer = await this.kafka.getProducer();
    await producer.send({
      topic: this.config.KAFKA_TOPIC_DLQ,
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: {
            ...message.headers,
            'x-original-topic': raw.topic,
            'x-original-partition': String(raw.partition),
            'x-original-offset': raw.offset,
            'x-error': err.message.slice(0, 1000),
            'x-failed-at': new Date().toISOString(),
          },
        },
      ],
    });
    // Remember dead-lettered event ids so a redelivery is treated as a duplicate.
    if (err.eventId) {
      await this.db
        .query(
          `INSERT INTO processed_messages (message_id, topic, partition, "offset", outcome)
           VALUES ($1, $2, $3, $4, 'dead_lettered') ON CONFLICT DO NOTHING`,
          [err.eventId, raw.topic, raw.partition, raw.offset],
        )
        .catch((e: Error) => this.logger.warn({ err: e }, 'Could not record dead-lettered message'));
    }
    this.metrics.kafkaMessages.inc({ topic: raw.topic, type: 'unknown', outcome: 'dead_lettered' });
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    // disconnect() waits for the in-flight eachMessage to finish, then leaves the group.
    await this.consumer?.disconnect().catch((err: Error) => this.logger.warn({ err }, 'Consumer disconnect failed'));
  }
}
