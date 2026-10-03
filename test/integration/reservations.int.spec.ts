import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  assertInvariants,
  createProgram,
  rawMessage,
  programUpserted,
  reserve,
  resetDb,
  setup,
  TestContext,
} from './helpers';

jest.setTimeout(30_000);

describe('Reservations API', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetDb(ctx.pool);
    await createProgram(ctx, 'P-USD', 'USD', '10000000.00');
    await createProgram(ctx, 'P-JPY', 'JPY', '1000000');
  });
  afterEach(() => assertInvariants(ctx.pool));

  const capacity = async (programId = 'P-USD') =>
    (await ctx.http().get(`/v1/programs/${programId}/capacity`).set(ctx.auth).expect(200)).body;

  describe('reserve', () => {
    it('reserves capacity and returns 201 with Location and updated capacity', async () => {
      const res = await reserve(ctx, 'P-USD', 'INV-1', '500000.00', 'USD').expect(201);
      expect(res.headers.location).toBe('/v1/programs/P-USD/reservations/INV-1');
      expect(res.body.reservation).toMatchObject({ invoiceId: 'INV-1', status: 'RESERVED', createdBy: 'test-client' });
      expect(res.body.capacity).toMatchObject({ limit: '10000000.00', reserved: '500000.00', available: '9500000.00' });
    });

    it('converts a foreign-currency invoice at reservation time and stores the rate', async () => {
      const res = await reserve(ctx, 'P-USD', 'INV-EUR', '100000.00', 'EUR').expect(201);
      expect(res.body.reservation.invoice).toEqual({ currency: 'EUR', amount: '100000.00', outstanding: '100000.00' });
      expect(res.body.reservation.program).toEqual({ currency: 'USD', amount: '108000.00', outstanding: '108000.00' });
      expect(res.body.reservation.fx).toMatchObject({ rate: '1.08', source: 'static-config' });
    });

    it('handles zero-decimal currencies (USD invoice on JPY program rounds up)', async () => {
      const res = await reserve(ctx, 'P-JPY', 'INV-1', '10.01', 'USD').expect(201);
      expect(res.body.reservation.program.amount).toBe('1502'); // 1501.5 -> 1502
    });

    it('allows reserving exactly the remaining capacity', async () => {
      await reserve(ctx, 'P-USD', 'INV-1', '10000000.00', 'USD').expect(201);
      expect((await capacity()).available).toBe('0.00');
    });

    it('rejects over-allocation with 409 INSUFFICIENT_CAPACITY and problem+json', async () => {
      await reserve(ctx, 'P-USD', 'INV-1', '9000000.00', 'USD').expect(201);
      const res = await reserve(ctx, 'P-USD', 'INV-2', '1000000.01', 'USD').expect(409);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        code: 'INSUFFICIENT_CAPACITY',
        available: '1000000.00',
        requested: '1000000.01',
      });
    });

    it.each([
      [{ invoiceId: 'X', amount: 100, currency: 'USD' }, 400, 'VALIDATION_FAILED'],
      [{ invoiceId: 'X', amount: '1e5', currency: 'USD' }, 400, 'VALIDATION_FAILED'],
      [{ invoiceId: 'X', amount: '-5', currency: 'USD' }, 400, 'VALIDATION_FAILED'],
      [{ invoiceId: 'X', amount: '0', currency: 'USD' }, 400, 'INVALID_AMOUNT'],
      [{ invoiceId: 'X', amount: '1.001', currency: 'USD' }, 400, 'INVALID_AMOUNT_SCALE'],
      [{ invoiceId: 'X', amount: '1', currency: 'XYZ' }, 400, 'UNSUPPORTED_CURRENCY'],
      [{ invoiceId: 'X', amount: '1', currency: 'GBP' }, 422, 'UNSUPPORTED_CURRENCY_PAIR'],
      [{ invoiceId: 'X', amount: '1', currency: 'USD', extra: true }, 400, 'VALIDATION_FAILED'],
      [{ invoiceId: 'bad id!', amount: '1', currency: 'USD' }, 400, 'VALIDATION_FAILED'],
    ])('rejects %o with %d %s', async (body, status, code) => {
      const res = await ctx.http().post('/v1/programs/P-USD/reservations').set(ctx.auth).send(body).expect(status);
      expect(res.body.code).toBe(code);
    });

    it('404 for unknown program', async () => {
      const res = await reserve(ctx, 'NOPE', 'INV-1', '1.00', 'USD').expect(404);
      expect(res.body.code).toBe('PROGRAM_NOT_FOUND');
    });

    it('409 PROGRAM_NOT_ACTIVE for suspended programs', async () => {
      await ctx.handler.handle(
        rawMessage(programUpserted('P-USD', 'USD', '10000000.00', { seq: 2, status: 'SUSPENDED' })),
      );
      const res = await reserve(ctx, 'P-USD', 'INV-1', '1.00', 'USD').expect(409);
      // Regression: a `status` detail must never override the problem's HTTP status.
      expect(res.body).toMatchObject({ status: 409, code: 'PROGRAM_NOT_ACTIVE', programStatus: 'SUSPENDED' });
    });
  });

  describe('duplicates and idempotency', () => {
    it('same invoice and amount without a key returns 200 with the existing reservation', async () => {
      const first = await reserve(ctx, 'P-USD', 'INV-1', '100.00', 'USD').expect(201);
      const second = await reserve(ctx, 'P-USD', 'INV-1', '100.00', 'USD').expect(200);
      expect(second.body.reservation.id).toBe(first.body.reservation.id);
      expect((await capacity()).reserved).toBe('100.00');
    });

    it('same invoice with a different amount is 409 INVOICE_ALREADY_RESERVED', async () => {
      await reserve(ctx, 'P-USD', 'INV-1', '100.00', 'USD').expect(201);
      const res = await reserve(ctx, 'P-USD', 'INV-1', '200.00', 'USD').expect(409);
      expect(res.body).toMatchObject({ code: 'INVOICE_ALREADY_RESERVED', existingStatus: 'RESERVED' });
    });

    it('Idempotency-Key replays the original response, including status', async () => {
      const headers = { 'Idempotency-Key': 'key-00000001' };
      const first = await reserve(ctx, 'P-USD', 'INV-1', '100.00', 'USD', headers).expect(201);
      const replay = await reserve(ctx, 'P-USD', 'INV-1', '100.00', 'USD', headers).expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
    });

    it('Idempotency-Key reused with a different body is 422', async () => {
      const headers = { 'Idempotency-Key': 'key-00000002' };
      await reserve(ctx, 'P-USD', 'INV-1', '100.00', 'USD', headers).expect(201);
      const res = await reserve(ctx, 'P-USD', 'INV-2', '100.00', 'USD', headers).expect(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('failed requests are not cached under the key (retry re-evaluates)', async () => {
      const headers = { 'Idempotency-Key': 'key-00000003' };
      await reserve(ctx, 'P-USD', 'BIG', '9999999.00', 'USD').expect(201);
      await reserve(ctx, 'P-USD', 'INV-1', '5.00', 'USD', headers).expect(409);
      await ctx.http().post('/v1/programs/P-USD/reservations/BIG/release').set(ctx.auth).send({}).expect(200);
      await reserve(ctx, 'P-USD', 'INV-1', '5.00', 'USD', headers).expect(201);
    });

    it('rejects malformed Idempotency-Key', async () => {
      const res = await reserve(ctx, 'P-USD', 'INV-1', '1.00', 'USD', { 'Idempotency-Key': 'short' }).expect(400);
      expect(res.body.code).toBe('INVALID_IDEMPOTENCY_KEY');
    });

    it('keys are scoped per client', async () => {
      const headers = { 'Idempotency-Key': 'key-shared-1' };
      await reserve(ctx, 'P-USD', 'INV-1', '1.00', 'USD', headers).expect(201);
      const other = { Authorization: `Bearer ${await ctx.token({ sub: 'other-client' })}` };
      await ctx
        .http()
        .post('/v1/programs/P-USD/reservations')
        .set(other)
        .set(headers)
        .send({ invoiceId: 'INV-2', amount: '1.00', currency: 'USD' })
        .expect(201);
    });
  });

  describe('release and cancel', () => {
    beforeEach(async () => {
      await reserve(ctx, 'P-USD', 'INV-EUR', '100000.00', 'EUR').expect(201); // 108,000.00 USD
    });

    const release = (body: object, invoice = 'INV-EUR') =>
      ctx.http().post(`/v1/programs/P-USD/reservations/${invoice}/release`).set(ctx.auth).send(body);

    it('full release returns exactly the reserved program amount', async () => {
      const res = await release({}).expect(200);
      expect(res.body.reservation).toMatchObject({ status: 'RELEASED' });
      expect(res.body.reservation.closedAt).not.toBeNull();
      expect(res.body.capacity.reserved).toBe('0.00');
    });

    it('repeated full release is an idempotent no-op', async () => {
      await release({}).expect(200);
      const again = await release({}).expect(200);
      expect(again.body.capacity).toMatchObject({ reserved: '0.00', version: expect.any(Number) });
      const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE type = 'RELEASE'`);
      expect(rows[0].n).toBe(1);
    });

    it('partial releases in invoice currency use the locked rate', async () => {
      const r1 = await release({ amount: '40000.00', currency: 'EUR' }).expect(200);
      expect(r1.body.reservation).toMatchObject({ status: 'PARTIALLY_RELEASED' });
      expect(r1.body.reservation.program.outstanding).toBe('64800.00');
      const r2 = await release({ amount: '60000.00', currency: 'EUR' }).expect(200);
      expect(r2.body.reservation.status).toBe('RELEASED');
      expect(r2.body.capacity.reserved).toBe('0.00');
    });

    it.each([
      [{ amount: '100000.01', currency: 'EUR' }, 422, 'RELEASE_EXCEEDS_OUTSTANDING'],
      [{ amount: '10.00', currency: 'USD' }, 422, 'CURRENCY_MISMATCH'],
      [{ amount: '10.00' }, 400, 'INVALID_RELEASE'],
    ])('rejects release %o with %d %s', async (body, status, code) => {
      expect((await release(body).expect(status)).body.code).toBe(code);
    });

    it('404 for unknown invoice', async () => {
      expect((await release({}, 'NOPE').expect(404)).body.code).toBe('RESERVATION_NOT_FOUND');
    });

    it('releases are allowed on suspended programs (repayments still happen)', async () => {
      await ctx.handler.handle(
        rawMessage(programUpserted('P-USD', 'USD', '10000000.00', { seq: 2, status: 'SUSPENDED' })),
      );
      await release({}).expect(200);
    });

    it('cancel frees capacity and is idempotent; cannot cancel after repayment started', async () => {
      const cancel = (invoice: string) =>
        ctx.http().post(`/v1/programs/P-USD/reservations/${invoice}/cancel`).set(ctx.auth).send();
      expect((await cancel('INV-EUR').expect(200)).body.reservation.status).toBe('CANCELLED');
      await cancel('INV-EUR').expect(200);
      expect((await release({}).expect(409)).body.code).toBe('INVALID_STATE_TRANSITION');

      await reserve(ctx, 'P-USD', 'INV-2', '10.00', 'USD').expect(201);
      await release({ amount: '1.00', currency: 'USD' }, 'INV-2').expect(200);
      expect((await cancel('INV-2').expect(409)).body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('a cancelled or released invoice cannot be reserved again with a different amount', async () => {
      await release({}).expect(200);
      expect((await reserve(ctx, 'P-USD', 'INV-EUR', '1.00', 'EUR').expect(409)).body.code).toBe(
        'INVOICE_ALREADY_RESERVED',
      );
    });
  });

  describe('limit changes', () => {
    it('limit lowered below utilisation: available goes negative and new reservations are refused', async () => {
      await reserve(ctx, 'P-USD', 'INV-1', '8000000.00', 'USD').expect(201);
      await ctx.handler.handle(rawMessage(programUpserted('P-USD', 'USD', '5000000.00', { seq: 2 })));
      expect(await capacity()).toMatchObject({ limit: '5000000.00', reserved: '8000000.00', available: '-3000000.00' });
      expect((await reserve(ctx, 'P-USD', 'INV-2', '0.01', 'USD').expect(409)).body.code).toBe('INSUFFICIENT_CAPACITY');
      await ctx.http().post('/v1/programs/P-USD/reservations/INV-1/release').set(ctx.auth).send({}).expect(200);
      await reserve(ctx, 'P-USD', 'INV-2', '0.01', 'USD').expect(201);
    });
  });

  describe('reads', () => {
    it('capacity supports ETag / If-None-Match', async () => {
      const first = await ctx.http().get('/v1/programs/P-USD/capacity').set(ctx.auth).expect(200);
      await ctx
        .http()
        .get('/v1/programs/P-USD/capacity')
        .set(ctx.auth)
        .set('If-None-Match', first.headers.etag)
        .expect(304);
      await reserve(ctx, 'P-USD', 'INV-1', '1.00', 'USD').expect(201);
      await ctx
        .http()
        .get('/v1/programs/P-USD/capacity')
        .set(ctx.auth)
        .set('If-None-Match', first.headers.etag)
        .expect(200);
    });

    it('lists programs and paginates reservations with a cursor', async () => {
      expect(
        (await ctx.http().get('/v1/programs').set(ctx.auth).expect(200)).body.items.map(
          (p: { programId: string }) => p.programId,
        ),
      ).toEqual(['P-JPY', 'P-USD']);
      for (let i = 0; i < 5; i++) await reserve(ctx, 'P-USD', `INV-${i}`, '1.00', 'USD').expect(201);
      const page1 = await ctx.http().get('/v1/programs/P-USD/reservations?limit=3').set(ctx.auth).expect(200);
      expect(page1.body.items.map((r: { invoiceId: string }) => r.invoiceId)).toEqual(['INV-0', 'INV-1', 'INV-2']);
      const page2 = await ctx
        .http()
        .get(`/v1/programs/P-USD/reservations?limit=3&cursor=${page1.body.nextCursor}`)
        .set(ctx.auth)
        .expect(200);
      expect(page2.body.items.map((r: { invoiceId: string }) => r.invoiceId)).toEqual(['INV-3', 'INV-4']);
      expect(page2.body.nextCursor).toBeNull();
      await ctx.http().get('/v1/programs/P-USD/reservations?cursor=!!').set(ctx.auth).expect(400);
    });

    it('ledger records every movement with actor and formatted amounts', async () => {
      await reserve(ctx, 'P-USD', 'INV-1', '10.00', 'USD').expect(201);
      const res = await ctx.http().get('/v1/programs/P-USD/ledger').set(ctx.auth).expect(200);
      expect(res.body.items.map((e: { type: string }) => e.type)).toEqual(['LIMIT_CHANGE', 'RESERVE']);
      expect(res.body.items[1]).toMatchObject({ reservedDelta: '10.00', reservedAfter: '10.00', actor: 'test-client' });
    });

    it('ledger is append-only at the database level', async () => {
      await expect(ctx.pool.query('UPDATE ledger_entries SET actor = $1', ['x'])).rejects.toThrow(/append-only/);
      await expect(ctx.pool.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/);
    });

    it('lists newest first with order=desc and pages backwards with the cursor', async () => {
      for (let i = 0; i < 5; i++) await reserve(ctx, 'P-USD', `INV-${i}`, '1.00', 'USD').expect(201);
      const ids = (res: { body: { items: { invoiceId: string }[] } }) => res.body.items.map((r) => r.invoiceId);
      const p1 = await ctx.http().get('/v1/programs/P-USD/reservations?order=desc&limit=2').set(ctx.auth).expect(200);
      expect(ids(p1)).toEqual(['INV-4', 'INV-3']);
      const p2 = await ctx
        .http()
        .get(`/v1/programs/P-USD/reservations?order=desc&limit=2&cursor=${p1.body.nextCursor}`)
        .set(ctx.auth)
        .expect(200);
      expect(ids(p2)).toEqual(['INV-2', 'INV-1']);
    });

    it('ledger supports order=desc with cursor pagination', async () => {
      for (let i = 0; i < 3; i++) await reserve(ctx, 'P-USD', `INV-${i}`, '1.00', 'USD').expect(201);
      const p1 = await ctx.http().get('/v1/programs/P-USD/ledger?order=desc&limit=2').set(ctx.auth).expect(200);
      expect(p1.body.items.map((e: { details: { invoiceId?: string } }) => e.details.invoiceId)).toEqual([
        'INV-2',
        'INV-1',
      ]);
      const p2 = await ctx
        .http()
        .get(`/v1/programs/P-USD/ledger?order=desc&limit=2&cursor=${p1.body.nextCursor}`)
        .set(ctx.auth)
        .expect(200);
      expect(p2.body.items.map((e: { type: string }) => e.type)).toEqual(['RESERVE', 'LIMIT_CHANGE']);
      expect(p2.body.nextCursor).toBeNull();
    });

    it('rejects oversized and malformed bodies with problem+json (not 500)', async () => {
      const big = await ctx
        .http()
        .post('/v1/programs/P-USD/reservations')
        .set(ctx.auth)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ invoiceId: 'x'.repeat(200_000) }))
        .expect(413);
      expect(big.body).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
      const bad = await ctx
        .http()
        .post('/v1/programs/P-USD/reservations')
        .set(ctx.auth)
        .set('Content-Type', 'application/json')
        .send('{"invoiceId":')
        .expect(400);
      expect(bad.headers['content-type']).toMatch(/application\/problem\+json/);
    });

    it('a converted amount outside the supported range is 422 AMOUNT_OUT_OF_RANGE', async () => {
      const res = await reserve(ctx, 'P-JPY', 'HUGE', '10000000000000000', 'USD').expect(422);
      expect(res.body.code).toBe('AMOUNT_OUT_OF_RANGE');
    });

    it('propagates X-Request-Id', async () => {
      const res = await ctx
        .http()
        .get('/v1/programs/NOPE/capacity')
        .set(ctx.auth)
        .set('X-Request-Id', 'req-123')
        .expect(404);
      expect(res.headers['x-request-id']).toBe('req-123');
      expect(res.body.requestId).toBe('req-123');
    });
  });

  describe('SSE stream', () => {
    it('emits the current capacity, then every change', async () => {
      const { port } = (ctx.app.getHttpServer() as http.Server).address() as AddressInfo;
      const events: { version: number; reserved: string }[] = [];

      const req = http.get({
        port,
        path: '/v1/programs/P-USD/capacity/stream',
        headers: { ...ctx.auth, Accept: 'text/event-stream' },
      });
      const done = new Promise<void>((resolve, reject) => {
        req.on('response', (res) => {
          expect(res.statusCode).toBe(200);
          let buf = '';
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString();
            for (const m of buf.matchAll(/event: capacity\nid: \d+\ndata: (.+)\n/g)) {
              const data = JSON.parse(m[1]);
              if (!events.some((e) => e.version === data.version)) events.push(data);
            }
            if (events.length >= 2) resolve();
          });
        });
        req.on('error', reject);
      });

      await new Promise((r) => setTimeout(r, 300));
      await reserve(ctx, 'P-USD', 'INV-SSE', '42.00', 'USD').expect(201);
      await done;
      req.destroy();
      expect(events[0].reserved).toBe('0.00');
      expect(events[1].reserved).toBe('42.00');
    });
  });
});
