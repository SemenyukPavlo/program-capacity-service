import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { exportSPKI, generateKeyPair, KeyLike, SignJWT } from 'jose';
import { Pool } from 'pg';
import request from 'supertest';
import { loadConfig } from '../../src/config/config';
import { createApp } from '../../src/main';
import { TreasuryHandler } from '../../src/treasury/treasury.handler';

export const ISSUER = 'https://idp.test';
export const AUDIENCE = 'program-capacity-api';
export const ALL_SCOPES = 'capacity:read reservations:write reservations:release';

export interface TokenOptions {
  sub?: string;
  scope?: string;
  programs?: string[] | '*';
  expiresIn?: string;
  issuer?: string;
  audience?: string;
  key?: KeyLike;
}

export interface TestContext {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  pool: Pool;
  handler: TreasuryHandler;
  token: (opts?: TokenOptions) => Promise<string>;
  /** Bearer header for the all-access client. */
  auth: Record<string, string>;
  close: () => Promise<void>;
}

export async function setup(env: Record<string, string> = {}): Promise<TestContext> {
  const databaseUrl = process.env.TEST_DATABASE_URL!;
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    KAFKA_ENABLED: 'false',
    AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: AUDIENCE,
    AUTH_PUBLIC_KEY_PEM: await exportSPKI(publicKey),
    FX_STATIC_RATES: 'EUR:USD=1.08,USD:JPY=150',
    RATE_LIMIT_PER_MINUTE: '1000000',
    RUN_MIGRATIONS: 'false',
    ...env,
  });
  const app = await createApp(config);
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  const token = async (opts: TokenOptions = {}) =>
    new SignJWT({ scope: opts.scope ?? ALL_SCOPES, programs: opts.programs ?? '*' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setSubject(opts.sub ?? 'test-client')
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '5m')
      .sign(opts.key ?? privateKey);

  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  return {
    app,
    http: () => request(baseUrl),
    pool,
    handler: app.get(TreasuryHandler),
    token,
    auth: { Authorization: `Bearer ${await token()}` },
    close: async () => {
      await pool.end();
      await app.close();
    },
  };
}

export async function resetDb(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE programs, reservations, ledger_entries, processed_messages, idempotency_keys,
                    reconciliation_runs, outbox RESTART IDENTITY CASCADE`);
}

let offsetCounter = 0;

export function rawMessage(value: unknown, topic = 'treasury.program-events') {
  return {
    topic,
    partition: 0,
    offset: String(offsetCounter++),
    key: typeof value === 'object' && value !== null ? String((value as { programId?: string }).programId) : null,
    value: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  };
}

export function programUpserted(
  programId: string,
  currency: string,
  limit: string,
  opts: { seq?: number; status?: string; eventId?: string } = {},
) {
  return {
    type: 'PROGRAM_UPSERTED',
    schemaVersion: 1,
    eventId: opts.eventId ?? randomUUID(),
    programId,
    seq: opts.seq ?? 1,
    occurredAt: new Date().toISOString(),
    currency,
    limit,
    status: opts.status ?? 'ACTIVE',
  };
}

export function snapshot(
  programId: string,
  currency: string,
  limit: string,
  reservations: Record<string, string>,
  opts: { seq: number; asOf?: Date; status?: string; eventId?: string },
) {
  return {
    type: 'PROGRAM_SNAPSHOT',
    schemaVersion: 1,
    eventId: opts.eventId ?? randomUUID(),
    programId,
    seq: opts.seq,
    occurredAt: new Date().toISOString(),
    asOf: (opts.asOf ?? new Date()).toISOString(),
    currency,
    limit,
    status: opts.status ?? 'ACTIVE',
    reservations: Object.entries(reservations).map(([invoiceId, outstandingAmount]) => ({
      invoiceId,
      outstandingAmount,
    })),
  };
}

export async function createProgram(ctx: TestContext, id: string, currency: string, limit: string, seq = 1) {
  await ctx.handler.handle(rawMessage(programUpserted(id, currency, limit, { seq })));
}

export function reserve(
  ctx: TestContext,
  programId: string,
  invoiceId: string,
  amount: string,
  currency: string,
  headers: Record<string, string> = {},
) {
  return ctx
    .http()
    .post(`/v1/programs/${programId}/reservations`)
    .set(ctx.auth)
    .set(headers)
    .send({ invoiceId, amount, currency });
}

/**
 * The core invariants, checked after every integration test:
 *   programs.reserved_amount == Σ reservations.outstanding_program_amount == Σ ledger reserved_delta
 */
export async function assertInvariants(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ id: string; reserved: string; rows_sum: string; ledger_sum: string }>(`
    SELECT p.id,
           p.reserved_amount::text AS reserved,
           COALESCE((SELECT SUM(outstanding_program_amount) FROM reservations r WHERE r.program_id = p.id), 0)::text AS rows_sum,
           COALESCE((SELECT SUM(reserved_delta) FROM ledger_entries l WHERE l.program_id = p.id), 0)::text AS ledger_sum
      FROM programs p`);
  for (const r of rows) {
    expect({ program: r.id, rows: Number(r.rows_sum), ledger: Number(r.ledger_sum) }).toEqual({
      program: r.id,
      rows: Number(r.reserved),
      ledger: Number(r.reserved),
    });
  }
}
