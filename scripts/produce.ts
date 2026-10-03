/**
 * Simulates the treasury system by publishing messages to Kafka. Runs as compose services:
 *
 *   seed            publishes the seed programs on `docker compose up` (idempotent)
 *   treasury-sim    `serve` mode: HTTP endpoint used by the playground UI (POST /send {command, args})
 *
 * One-off commands:
 *   docker compose run --rm seed program   <programId> <currency> <limit> [ACTIVE|SUSPENDED|CLOSED]
 *   docker compose run --rm seed release   <programId> <invoiceId> [<amount> <currency>]
 *   docker compose run --rm seed snapshot  <programId> <currency> <limit> [status] [<invoiceId>=<outstanding> ...]
 *   docker compose run --rm seed duplicate <programId> [<currency> <limit>]   # same event twice -> applied once
 *   docker compose run --rm seed stale     <programId> [<currency>]           # seq 0 -> ignored as stale
 *   docker compose run --rm seed poison                                      # invalid message -> DLQ
 *
 * seq defaults to Date.now() so successive manual commands are always "newer".
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Kafka, logLevel, Partitioners, Producer } from 'kafkajs';

const brokers = (process.env.KAFKA_BROKERS ?? 'kafka:9092').split(',');
const PROGRAM_TOPIC = process.env.KAFKA_TOPIC_PROGRAM_EVENTS ?? 'treasury.program-events';
const RECON_TOPIC = process.env.KAFKA_TOPIC_RECONCILIATION ?? 'treasury.reconciliation';

type Message = Record<string, unknown> & { programId?: string };
type Send = { topic: string; message: Message | string };

class UsageError extends Error {}

const now = () => new Date().toISOString();

function programUpserted(
  programId: string,
  currency: string,
  limit: string,
  status = 'ACTIVE',
  seq = Date.now(),
  eventId: string = randomUUID(),
): Message {
  return {
    type: 'PROGRAM_UPSERTED',
    schemaVersion: 1,
    eventId,
    programId,
    seq,
    occurredAt: now(),
    currency,
    limit,
    status,
  };
}

const SEED: Message[] = [
  programUpserted('PRG-USD-001', 'USD', '10000000.00', 'ACTIVE', 1, 'seed-PRG-USD-001'),
  programUpserted('PRG-EUR-001', 'EUR', '5000000.00', 'ACTIVE', 1, 'seed-PRG-EUR-001'),
  programUpserted('PRG-JPY-001', 'JPY', '1000000000', 'ACTIVE', 1, 'seed-PRG-JPY-001'),
];

/** Translates a command into the messages to publish. Throws UsageError on bad arguments. */
function buildMessages(command: string | undefined, args: string[]): Send[] {
  switch (command) {
    case 'seed':
      return SEED.map((m) => ({ topic: PROGRAM_TOPIC, message: m }));
    case 'program': {
      const [programId, currency, limit, status] = need(args, 3, 'program <programId> <currency> <limit> [status]');
      return [{ topic: PROGRAM_TOPIC, message: programUpserted(programId, currency, limit, status || 'ACTIVE') }];
    }
    case 'release': {
      const [programId, invoiceId, amount, currency] = need(
        args,
        2,
        'release <programId> <invoiceId> [<amount> <currency>]',
      );
      return [
        {
          topic: PROGRAM_TOPIC,
          message: {
            type: 'RESERVATION_RELEASED',
            schemaVersion: 1,
            eventId: randomUUID(),
            programId,
            seq: Date.now(),
            occurredAt: now(),
            invoiceId,
            ...(amount ? { amount, currency } : {}),
          },
        },
      ];
    }
    case 'snapshot': {
      const [programId, currency, limit, ...rest] = need(
        args,
        3,
        'snapshot <programId> <currency> <limit> [status] [invoiceId=amount ...]',
      );
      // Optional status right after the limit; defaults to ACTIVE.
      const status = /^(ACTIVE|SUSPENDED|CLOSED)$/.test(rest[0] ?? '') ? rest.shift()! : 'ACTIVE';
      const reservations = rest.map((i) => {
        const [invoiceId, outstandingAmount] = i.split('=');
        if (!invoiceId || !outstandingAmount)
          throw new UsageError(`Invalid reservation "${i}", expected invoiceId=amount`);
        return { invoiceId, outstandingAmount };
      });
      return [
        {
          topic: RECON_TOPIC,
          message: {
            type: 'PROGRAM_SNAPSHOT',
            schemaVersion: 1,
            eventId: randomUUID(),
            programId,
            seq: Date.now(),
            occurredAt: now(),
            asOf: now(),
            currency,
            limit,
            status,
            reservations,
          },
        },
      ];
    }
    case 'duplicate': {
      const [programId, currency = 'USD', limit = '12000000.00'] = need(
        args,
        1,
        'duplicate <programId> [currency limit]',
      );
      const m = programUpserted(programId, currency, limit);
      return [
        { topic: PROGRAM_TOPIC, message: m },
        { topic: PROGRAM_TOPIC, message: m },
      ];
    }
    case 'stale': {
      const [programId, currency = 'USD'] = need(args, 1, 'stale <programId> [currency]');
      return [{ topic: PROGRAM_TOPIC, message: programUpserted(programId, currency, '1', 'ACTIVE', 0) }];
    }
    case 'poison':
      return [{ topic: PROGRAM_TOPIC, message: '{"type":"PROGRAM_UPSERTED","limit":12.5}' }];
    default:
      throw new UsageError(`Unknown command "${command ?? ''}"; see header of scripts/produce.ts`);
  }
}

async function connect(): Promise<Producer> {
  const kafka = new Kafka({ clientId: 'treasury-simulator', brokers, logLevel: logLevel.WARN });
  const producer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 1,
    createPartitioner: Partitioners.DefaultPartitioner,
  });
  await producer.connect();
  return producer;
}

async function publish(producer: Producer, sends: Send[]): Promise<string[]> {
  const lines: string[] = [];
  for (const { topic, message } of sends) {
    const key = typeof message === 'string' ? 'poison' : String(message.programId);
    const value = typeof message === 'string' ? message : JSON.stringify(message);
    await producer.send({ topic, messages: [{ key, value }] });
    lines.push(`-> ${topic} [${key}] ${value}`);
  }
  return lines;
}

/** HTTP mode for the playground: POST /send {"command": "...", "args": ["..."]}. Dev only, no auth. */
async function serve(): Promise<void> {
  const producer = await connect();
  const port = Number(process.env.PORT ?? 3417);
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (req.method === 'GET' && req.url === '/health') return reply(200, { status: 'ok' });
    if (req.method !== 'POST' || req.url !== '/send') return reply(404, { error: 'not_found' });
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { command, args = [] } = JSON.parse(raw || '{}') as { command?: string; args?: unknown[] };
      const sent = await publish(producer, buildMessages(command, args.map(String)));
      reply(200, { sent });
    } catch (err) {
      reply(err instanceof UsageError || err instanceof SyntaxError ? 400 : 500, { error: (err as Error).message });
    }
  });
  server.listen(port, () => console.log(`treasury simulator listening on :${port}`));
  process.once('SIGTERM', () => {
    server.close();
    void producer.disconnect();
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'serve') return serve();
  let sends: Send[];
  try {
    sends = buildMessages(command, args);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const producer = await connect();
  for (const line of await publish(producer, sends)) console.log(line);
  await producer.disconnect();
}

function need(args: string[], n: number, usage: string): string[] {
  if (args.length < n) throw new UsageError(`Usage: ${usage}`);
  return args;
}

if (require.main === module) void main();
