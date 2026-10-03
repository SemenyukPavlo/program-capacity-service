import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Kafka, logLevel, Partitioners, Producer } from 'kafkajs';
import { APP_CONFIG, AppConfig } from '../config/config';

/** Shared Kafka client and an idempotent producer (used by the DLQ and the outbox relay). */
@Injectable()
export class KafkaService implements OnModuleDestroy {
  private readonly logger = new Logger('Kafka');
  readonly kafka: Kafka;
  private producer?: Promise<Producer>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.kafka = new Kafka({
      clientId: config.KAFKA_CLIENT_ID,
      brokers: config.KAFKA_BROKERS,
      retry: { initialRetryTime: 300, retries: 10 },
      logLevel: logLevel.WARN,
      logCreator:
        () =>
        ({ level, log }) => {
          const { message, ...extra } = log;
          if (level <= logLevel.ERROR) this.logger.error(extra, message);
          else if (level === logLevel.WARN) this.logger.warn(extra, message);
          else this.logger.debug?.(extra, message);
        },
    });
  }

  getProducer(): Promise<Producer> {
    this.producer ??= (async () => {
      const p = this.kafka.producer({
        idempotent: true,
        maxInFlightRequests: 1,
        // Murmur2 (Java-client compatible) partitioning: same programId -> same partition across clients.
        createPartitioner: Partitioners.DefaultPartitioner,
      });
      await p.connect();
      return p;
    })();
    return this.producer;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.producer) await (await this.producer).disconnect().catch(() => undefined);
  }
}
