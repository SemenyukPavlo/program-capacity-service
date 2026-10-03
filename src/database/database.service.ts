import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/config';

export type Tx = PoolClient;

const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      application_name: 'program-capacity-service',
    });
    this.pool.on('error', (err) => this.logger.error({ err }, 'Idle PostgreSQL client error'));
  }

  async query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(sql, params);
    return res.rows;
  }

  /**
   * Runs `fn` in a READ COMMITTED transaction with statement/lock timeouts.
   * Deadlocks and serialization failures are retried with jittered backoff; everything else
   * is rethrown after rollback. `fn` must therefore be safe to re-run (it is: all side effects
   * are inside the transaction, and pg_notify is only delivered on commit).
   */
  async transaction<T>(fn: (tx: Tx) => Promise<T>, maxAttempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = ${this.config.DB_STATEMENT_TIMEOUT_MS}`);
        await client.query(`SET LOCAL lock_timeout = ${this.config.DB_LOCK_TIMEOUT_MS}`);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = (err as { code?: string }).code;
        if (code && RETRYABLE_SQLSTATES.has(code) && attempt < maxAttempts) {
          const delay = 20 * 2 ** attempt + Math.random() * 20;
          this.logger.warn({ code, attempt, delay }, 'Retrying transaction');
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
