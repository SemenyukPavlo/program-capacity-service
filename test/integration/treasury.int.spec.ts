import { PoisonMessageError } from '../../src/treasury/treasury.handler';
import {
  assertInvariants,
  createProgram,
  programUpserted,
  rawMessage,
  reserve,
  resetDb,
  setup,
  snapshot,
  TestContext,
} from './helpers';

jest.setTimeout(30_000);

const RECON = 'treasury.reconciliation';

describe('Treasury messages', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(() => ctx.close());
  beforeEach(() => resetDb(ctx.pool));
  afterEach(() => assertInvariants(ctx.pool));

  const handle = (msg: unknown, topic?: string) => ctx.handler.handle(rawMessage(msg, topic));
  const capacity = async (id = 'P') =>
    (await ctx.http().get(`/v1/programs/${id}/capacity`).set(ctx.auth).expect(200)).body;
  const reservation = async (invoiceId: string) =>
    (await ctx.http().get(`/v1/programs/P/reservations/${invoiceId}`).set(ctx.auth).expect(200)).body;

  describe('PROGRAM_UPSERTED', () => {
    it('creates, then updates limit and status', async () => {
      expect(await handle(programUpserted('P', 'USD', '100.00', { seq: 1 }))).toBe('applied');
      expect(await handle(programUpserted('P', 'USD', '250.00', { seq: 2, status: 'SUSPENDED' }))).toBe('applied');
      expect(await capacity()).toMatchObject({ limit: '250.00', status: 'SUSPENDED' });
      const ledger = (await ctx.http().get('/v1/programs/P/ledger').set(ctx.auth)).body.items;
      expect(ledger.map((e: { type: string }) => e.type)).toEqual(['LIMIT_CHANGE', 'LIMIT_CHANGE', 'STATUS_CHANGE']);
    });

    it('de-duplicates by eventId', async () => {
      const msg = programUpserted('P', 'USD', '100.00', { seq: 1 });
      expect(await handle(msg)).toBe('applied');
      expect(await handle(msg)).toBe('duplicate');
    });

    it('ignores stale (out-of-order) messages by seq', async () => {
      await handle(programUpserted('P', 'USD', '300.00', { seq: 5 }));
      expect(await handle(programUpserted('P', 'USD', '100.00', { seq: 4 }))).toBe('stale');
      expect(await handle(programUpserted('P', 'USD', '100.00', { seq: 5 }))).toBe('stale');
      expect((await capacity()).limit).toBe('300.00');
    });

    it('applies messages after a sequence gap (and flags it)', async () => {
      await handle(programUpserted('P', 'USD', '100.00', { seq: 1 }));
      expect(await handle(programUpserted('P', 'USD', '200.00', { seq: 7 }))).toBe('applied');
    });

    it('rejects a currency change once reservations exist', async () => {
      await createProgram(ctx, 'P', 'USD', '100.00');
      await reserve(ctx, 'P', 'I', '1.00', 'USD').expect(201);
      await expect(handle(programUpserted('P', 'EUR', '100.00', { seq: 2 }))).rejects.toThrow(
        /PROGRAM_CURRENCY_IMMUTABLE/,
      );
      expect((await capacity()).currency).toBe('USD');
    });
  });

  describe('poison messages', () => {
    it.each([
      ['not JSON', '{oops'],
      ['unknown type', { type: 'SOMETHING', eventId: 'e1' }],
      ['missing fields', { type: 'PROGRAM_UPSERTED', eventId: 'e2' }],
      ['number amount', { ...programUpserted('P', 'USD', '1'), limit: 100 }],
      ['unsupported currency', programUpserted('P', 'XXX', '1.00')],
      ['too many decimals for currency', programUpserted('P', 'JPY', '1.5')],
      [
        'duplicate invoice in snapshot',
        {
          ...snapshot('P', 'USD', '1.00', {}, { seq: 1 }),
          reservations: [
            { invoiceId: 'A', outstandingAmount: '1' },
            { invoiceId: 'A', outstandingAmount: '1' },
          ],
        },
      ],
    ])('%s -> PoisonMessageError (DLQ)', async (_, msg) => {
      await expect(handle(msg)).rejects.toBeInstanceOf(PoisonMessageError);
    });

    it('release for an unknown program is poison', async () => {
      await expect(
        handle({
          type: 'RESERVATION_RELEASED',
          schemaVersion: 1,
          eventId: 'r1',
          programId: 'NOPE',
          seq: 1,
          occurredAt: new Date().toISOString(),
          invoiceId: 'I',
        }),
      ).rejects.toThrow(/PROGRAM_NOT_FOUND/);
    });
  });

  describe('RESERVATION_RELEASED', () => {
    it('releases a reservation reported repaid by treasury (full and partial)', async () => {
      await createProgram(ctx, 'P', 'USD', '1000.00');
      await reserve(ctx, 'P', 'I', '100.00', 'EUR').expect(201); // 108.00 USD
      const base = {
        type: 'RESERVATION_RELEASED',
        schemaVersion: 1,
        programId: 'P',
        occurredAt: new Date().toISOString(),
        invoiceId: 'I',
      };
      await handle({ ...base, eventId: 'rel-1', seq: 2, amount: '50.00', currency: 'EUR' });
      expect((await reservation('I')).program.outstanding).toBe('54.00');
      await handle({ ...base, eventId: 'rel-2', seq: 3 });
      expect(await reservation('I')).toMatchObject({ status: 'RELEASED' });
      expect((await capacity()).reserved).toBe('0.00');
    });
  });

  describe('PROGRAM_SNAPSHOT (reconciliation)', () => {
    beforeEach(async () => {
      await createProgram(ctx, 'P', 'USD', '10000.00');
      for (const id of ['A', 'B', 'C']) await reserve(ctx, 'P', id, '1000.00', 'USD').expect(201);
    });

    it('treasury wins for everything it knew at asOf, and every change is audited', async () => {
      const asOf = new Date();
      const outcome = await handle(
        snapshot('P', 'USD', '9000.00', { A: '1000.00', B: '700.00', D: '2500.00' }, { seq: 2, asOf }),
        RECON,
      );
      expect(outcome).toBe('applied');

      expect(await capacity()).toMatchObject({ limit: '9000.00', reserved: '4200.00', available: '4800.00' });
      expect(await reservation('A')).toMatchObject({ status: 'RESERVED' });
      expect(await reservation('B')).toMatchObject({
        status: 'PARTIALLY_RELEASED',
        program: expect.objectContaining({ outstanding: '700.00' }),
      });
      expect(await reservation('C')).toMatchObject({ status: 'RELEASED' });
      expect(await reservation('D')).toMatchObject({
        status: 'RESERVED',
        source: 'RECONCILIATION',
        createdBy: 'treasury',
      });

      const { rows } = await ctx.pool.query(
        `SELECT status, discrepancies, reserved_before, reserved_after FROM reconciliation_runs`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('APPLIED');
      expect(
        rows[0].discrepancies.discrepancies
          .map((d: { invoiceId: string; reason: string }) => `${d.invoiceId}:${d.reason}`)
          .sort(),
      ).toEqual(['B:AMOUNT_MISMATCH', 'C:MISSING_IN_TREASURY', 'D:MISSING_LOCALLY']);
      const ledger = (await ctx.http().get('/v1/programs/P/ledger').set(ctx.auth)).body.items;
      expect(ledger.filter((e: { type: string }) => e.type === 'RECON_ADJUSTMENT')).toHaveLength(3);
    });

    it('keeps local changes made after the snapshot was taken', async () => {
      const asOf = new Date(Date.now() - 60_000); // snapshot taken before everything above
      await handle(snapshot('P', 'USD', '10000.00', {}, { seq: 2, asOf }), RECON);
      expect((await capacity()).reserved).toBe('3000.00');
      const { rows } = await ctx.pool.query(`SELECT discrepancies FROM reconciliation_runs`);
      expect(rows[0].discrepancies.kept).toHaveLength(3);
    });

    it('re-applying the same snapshot is a no-op; an older snapshot is stale', async () => {
      const msg = snapshot('P', 'USD', '10000.00', { A: '1000.00' }, { seq: 5 });
      await handle(msg, RECON);
      const after = await capacity();
      expect(await handle(msg, RECON)).toBe('duplicate');
      expect(await handle({ ...msg, eventId: 'other' }, RECON)).toBe('stale');
      expect(await handle(snapshot('P', 'USD', '1.00', {}, { seq: 4 }), RECON)).toBe('stale');
      expect(await capacity()).toEqual(after);
    });

    it('a snapshot for an unknown program creates it', async () => {
      await handle(snapshot('NEW', 'EUR', '500.00', { X: '100.00' }, { seq: 1 }), RECON);
      expect(await capacity('NEW')).toMatchObject({
        currency: 'EUR',
        limit: '500.00',
        reserved: '100.00',
        available: '400.00',
      });
    });

    it('re-opens a locally released reservation that treasury still considers outstanding', async () => {
      await ctx.http().post('/v1/programs/P/reservations/A/release').set(ctx.auth).send({}).expect(200);
      await new Promise((r) => setTimeout(r, 20));
      await handle(
        snapshot('P', 'USD', '10000.00', { A: '1000.00', B: '1000.00', C: '1000.00' }, { seq: 2, asOf: new Date() }),
        RECON,
      );
      expect(await reservation('A')).toMatchObject({ status: 'RESERVED' });
      expect((await capacity()).reserved).toBe('3000.00');
    });

    it('limit in snapshot below utilisation yields negative availability', async () => {
      await handle(snapshot('P', 'USD', '1000.00', { A: '1000.00', B: '1000.00', C: '1000.00' }, { seq: 2 }), RECON);
      expect(await capacity()).toMatchObject({ available: '-2000.00' });
    });

    it('corrects internal aggregate drift and records it', async () => {
      // Simulate a bug / manual edit that desynchronised the aggregate from its rows.
      await ctx.pool.query(`UPDATE programs SET reserved_amount = reserved_amount + 5 WHERE id = 'P'`);
      await ctx.pool.query(
        `INSERT INTO ledger_entries (program_id, type, reserved_delta, reserved_after, limit_after, actor)
         VALUES ('P', 'RECON_ADJUSTMENT', 5, 3005, 10000, 'test-corruption')`,
      );
      await handle(snapshot('P', 'USD', '10000.00', { A: '1000.00', B: '1000.00', C: '1000.00' }, { seq: 2 }), RECON);
      expect((await capacity()).reserved).toBe('3000.00');
      const { rows } = await ctx.pool.query(`SELECT discrepancies FROM reconciliation_runs`);
      expect(rows[0].discrepancies.discrepancies).toEqual([
        expect.objectContaining({ reason: 'INTERNAL_AGGREGATE_DRIFT', to: '-5.00' }),
      ]);
    });
  });

  describe('drift guard', () => {
    let guarded: TestContext;
    beforeAll(async () => {
      guarded = await setup({ RECON_MAX_AUTO_DRIFT_RATIO: '0.1' });
    });
    afterAll(() => guarded.close());

    it('does not auto-apply a snapshot whose drift exceeds the threshold', async () => {
      await createProgram(guarded, 'P', 'USD', '1000.00');
      await reserve(guarded, 'P', 'A', '500.00', 'USD').expect(201);
      const outcome = await guarded.handler.handle(
        rawMessage(snapshot('P', 'USD', '1000.00', {}, { seq: 2, asOf: new Date() }), RECON),
      );
      expect(outcome).toBe('requires_review');
      expect((await guarded.http().get('/v1/programs/P/capacity').set(guarded.auth)).body.reserved).toBe('500.00');
      const { rows } = await guarded.pool.query(`SELECT status FROM reconciliation_runs`);
      expect(rows[0].status).toBe('REQUIRES_REVIEW');
    });
  });
});
