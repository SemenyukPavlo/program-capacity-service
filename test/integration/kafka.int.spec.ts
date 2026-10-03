import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { Consumer, Kafka, logLevel, Partitioners, Producer } from 'kafkajs';
import { Pool } from 'pg';
import { programUpserted, reserve, resetDb, setup, TestContext } from './helpers';

jest.setTimeout(180_000);

const TOPICS = {
  KAFKA_TOPIC_PROGRAM_EVENTS: 'treasury.program-events',
  KAFKA_TOPIC_RECONCILIATION: 'treasury.reconciliation',
  KAFKA_TOPIC_DLQ: 'treasury.dlq',
  KAFKA_TOPIC_CAPACITY_EVENTS: 'capacity.events',
};

/** End-to-end through a real broker: consumer, DLQ and transactional outbox relay. */
describe('Kafka end-to-end', () => {
  let kafkaContainer: StartedKafkaContainer;
  let kafka: Kafka;
  let producer: Producer;
  let tap: Consumer;
  const tapped: Record<string, { key: string | null; value: string; headers: Record<string, string> }[]> = {};
  let ctx: TestContext;

  beforeAll(async () => {
    kafkaContainer = await new KafkaContainer('confluentinc/cp-kafka:7.6.1').withKraft().start();
    const brokers = [`${kafkaContainer.getHost()}:${kafkaContainer.getMappedPort(9093)}`];
    kafka = new Kafka({ clientId: 'test', brokers, logLevel: logLevel.NOTHING });

    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({ topics: Object.values(TOPICS).map((topic) => ({ topic, numPartitions: 3 })) });
    await admin.disconnect();

    producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
    await producer.connect();

    // Test-side consumer that records what the service publishes.
    tap = kafka.consumer({ groupId: `tap-${Date.now()}` });
    await tap.connect();
    await tap.subscribe({ topics: [TOPICS.KAFKA_TOPIC_DLQ, TOPICS.KAFKA_TOPIC_CAPACITY_EVENTS], fromBeginning: true });
    await tap.run({
      eachMessage: async ({ topic, message }) => {
        (tapped[topic] ??= []).push({
          key: message.key?.toString() ?? null,
          value: message.value?.toString() ?? '',
          headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)])),
        });
      },
    });

    // Reset before the app boots: the outbox relay starts with it and would otherwise publish rows
    // left behind by earlier spec files (they share the database but run without Kafka).
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await resetDb(pool);
    await pool.end();

    ctx = await setup({
      KAFKA_ENABLED: 'true',
      KAFKA_BROKERS: brokers.join(','),
      KAFKA_GROUP_ID: `svc-${Date.now()}`,
      ...TOPICS,
    });
  });

  afterAll(async () => {
    await ctx?.close();
    await tap?.disconnect();
    await producer?.disconnect();
    await kafkaContainer?.stop();
  });

  const send = (topic: string, key: string, value: unknown) =>
    producer.send({ topic, messages: [{ key, value: typeof value === 'string' ? value : JSON.stringify(value) }] });

  async function eventually<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await fn();
      if (value !== undefined && value !== false) return value as T;
      if (Date.now() > deadline) throw new Error('Condition not met in time');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  it('consumes treasury events, ignores duplicates, and the outbox publishes capacity changes', async () => {
    const msg = programUpserted('K-1', 'USD', '1000.00', { seq: 1 });
    await send(TOPICS.KAFKA_TOPIC_PROGRAM_EVENTS, 'K-1', msg);
    await send(TOPICS.KAFKA_TOPIC_PROGRAM_EVENTS, 'K-1', msg); // redelivery

    const cap = await eventually(async () => {
      const res = await ctx.http().get('/v1/programs/K-1/capacity').set(ctx.auth);
      return res.status === 200 ? res.body : undefined;
    });
    expect(cap).toMatchObject({ limit: '1000.00', available: '1000.00' });

    await eventually(async () => {
      const { rows } = await ctx.pool.query(`SELECT outcome FROM processed_messages WHERE message_id = $1`, [
        msg.eventId,
      ]);
      return rows[0]?.outcome === 'applied' || undefined;
    });

    await reserve(ctx, 'K-1', 'INV-1', '250.00', 'USD').expect(201);
    const reserved = await eventually(() =>
      (tapped[TOPICS.KAFKA_TOPIC_CAPACITY_EVENTS] ?? [])
        .map((m) => JSON.parse(m.value))
        .find((e) => e.cause === 'RESERVE' && e.programId === 'K-1'),
    );
    expect(reserved).toMatchObject({
      type: 'CAPACITY_CHANGED',
      programId: 'K-1',
      reserved: '250.00',
      available: '750.00',
    });
    const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL`);
    expect(rows[0].n).toBe(0);
  });

  it('routes poison messages to the DLQ with diagnostics and keeps consuming', async () => {
    await send(TOPICS.KAFKA_TOPIC_PROGRAM_EVENTS, 'K-2', '{"type":"PROGRAM_UPSERTED","limit":12.5}');
    await send(TOPICS.KAFKA_TOPIC_PROGRAM_EVENTS, 'K-2', programUpserted('K-2', 'EUR', '10.00', { seq: 1 }));

    const dlq = await eventually(() => tapped[TOPICS.KAFKA_TOPIC_DLQ]?.[0]);
    expect(dlq.value).toBe('{"type":"PROGRAM_UPSERTED","limit":12.5}');
    expect(dlq.headers).toMatchObject({ 'x-original-topic': TOPICS.KAFKA_TOPIC_PROGRAM_EVENTS });
    expect(dlq.headers['x-error']).toMatch(/Schema validation failed/);

    await eventually(async () => {
      const res = await ctx.http().get('/v1/programs/K-2/capacity').set(ctx.auth);
      return res.status === 200 || undefined;
    });
  });

  it('reports readiness including the consumer', async () => {
    const res = await ctx.http().get('/ready').expect(200);
    expect(res.body.checks).toEqual({ database: 'up', kafkaConsumer: 'up' });
  });
});
