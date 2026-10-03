import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Errors } from '../common/errors/domain-error';
import { Queryable } from './capacity.repository';

export interface IdempotencyContext {
  clientId: string;
  key: string;
  requestHash: string;
}

export interface HttpResult<T> {
  status: number;
  body: T;
  replayed?: boolean;
}

export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method} ${path}\n${canonicalJson(body)}`)
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Idempotency-Key handling, executed INSIDE the business transaction:
 *
 *  1. INSERT the key. A concurrent request with the same key blocks on the primary key until
 *     the first transaction finishes, so the operation can never run twice in parallel.
 *  2. On conflict, the committed row is returned (replay) if the request hash matches, and
 *     422 if the same key was reused for a different request.
 *  3. The response is stored in the same transaction as the business change, so they commit
 *     or roll back together. Failed requests (4xx/5xx) roll back and are therefore not cached:
 *     a retry re-evaluates, which is the useful behaviour for e.g. INSUFFICIENT_CAPACITY.
 */
@Injectable()
export class IdempotencyService {
  async run<T>(
    tx: Queryable,
    ctx: IdempotencyContext | undefined,
    fn: () => Promise<HttpResult<T>>,
  ): Promise<HttpResult<T>> {
    if (!ctx) return fn();

    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (client_id, idempotency_key, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING 1`,
      [ctx.clientId, ctx.key, ctx.requestHash],
    );

    if (inserted.rowCount === 0) {
      const res = await tx.query<{ request_hash: string; response_status: number | null; response_body: T }>(
        `SELECT request_hash, response_status, response_body
           FROM idempotency_keys WHERE client_id = $1 AND idempotency_key = $2`,
        [ctx.clientId, ctx.key],
      );
      const stored = res.rows[0];
      if (stored.request_hash !== ctx.requestHash) {
        throw Errors.unprocessable(
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used with a different request',
        );
      }
      if (stored.response_status === null) {
        throw Errors.conflict('REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is in progress');
      }
      return { status: stored.response_status, body: stored.response_body, replayed: true };
    }

    const result = await fn();
    await tx.query(
      `UPDATE idempotency_keys SET response_status = $3, response_body = $4
        WHERE client_id = $1 AND idempotency_key = $2`,
      [ctx.clientId, ctx.key, result.status, JSON.stringify(result.body)],
    );
    return result;
  }
}
