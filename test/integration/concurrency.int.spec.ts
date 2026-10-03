import { assertInvariants, createProgram, rawMessage, reserve, resetDb, setup, snapshot, TestContext } from './helpers';

jest.setTimeout(60_000);

/**
 * The invariants that matter most: under concurrent load the program is never over-allocated,
 * an invoice is never reserved twice, and the aggregate always equals its rows and the ledger.
 */
describe('Concurrency', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // Pool sized so requests genuinely run in parallel against PostgreSQL.
    ctx = await setup({ DB_POOL_MAX: '30' });
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetDb(ctx.pool);
    await createProgram(ctx, 'P', 'USD', '1000.00');
  });
  afterEach(() => assertInvariants(ctx.pool));

  const capacity = async () => (await ctx.http().get('/v1/programs/P/capacity').set(ctx.auth).expect(200)).body;

  it('never over-allocates: 50 parallel reservations of 100 against a 1000 limit -> exactly 10 succeed', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => reserve(ctx, 'P', `INV-${i}`, '100.00', 'USD')),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 409)).toHaveLength(40);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'INSUFFICIENT_CAPACITY')).toBe(true);
    expect(await capacity()).toMatchObject({ reserved: '1000.00', available: '0.00' });
  });

  it('two requests that each fit alone but not together: exactly one wins', async () => {
    const [a, b] = await Promise.all([
      reserve(ctx, 'P', 'A', '700.00', 'USD'),
      reserve(ctx, 'P', 'B', '500.00', 'USD'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(['700.00', '500.00']).toContain((await capacity()).reserved);
  });

  it('the same invoice reserved concurrently results in exactly one reservation', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => reserve(ctx, 'P', 'SAME', '10.00', 'USD')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.reservation.id)).size).toBe(1);
    expect((await capacity()).reserved).toBe('10.00');
  });

  it('the same Idempotency-Key sent concurrently executes once', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        reserve(ctx, 'P', 'IDEM', '10.00', 'USD', { 'Idempotency-Key': 'parallel-key-1' }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(19);
    expect((await capacity()).reserved).toBe('10.00');
  });

  it('concurrent reservations and releases keep the books balanced', async () => {
    for (let i = 0; i < 10; i++) await reserve(ctx, 'P', `OLD-${i}`, '50.00', 'USD').expect(201);
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) =>
        ctx.http().post(`/v1/programs/P/reservations/OLD-${i}/release`).set(ctx.auth).send({}),
      ),
      ...Array.from({ length: 30 }, (_, i) => reserve(ctx, 'P', `NEW-${i}`, '50.00', 'USD')),
    ]);
    const cap = await capacity();
    expect(Number(cap.reserved)).toBeLessThanOrEqual(1000);
  });

  it('concurrent repeated full releases release capacity once', async () => {
    await reserve(ctx, 'P', 'R', '300.00', 'USD').expect(201);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ctx.http().post('/v1/programs/P/reservations/R/release').set(ctx.auth).send({})),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await capacity()).reserved).toBe('0.00');
  });

  it('reconciliation running concurrently with API traffic: no deadlocks, invariants hold', async () => {
    for (let i = 0; i < 5; i++) await reserve(ctx, 'P', `BASE-${i}`, '20.00', 'USD').expect(201);
    const asOf = new Date();
    const snapshots = Array.from({ length: 5 }, (_, i) =>
      ctx.handler.handle(
        rawMessage(
          snapshot(
            'P',
            'USD',
            '1000.00',
            { 'BASE-0': '20.00', 'BASE-1': '10.00', [`TREASURY-${i}`]: '5.00' },
            { seq: 10 + i, asOf },
          ),
          'treasury.reconciliation',
        ),
      ),
    );
    const api = [
      ...Array.from({ length: 20 }, (_, i) => reserve(ctx, 'P', `LIVE-${i}`, '10.00', 'USD')),
      ...Array.from({ length: 3 }, (_, i) =>
        ctx
          .http()
          .post(`/v1/programs/P/reservations/BASE-${i + 2}/release`)
          .set(ctx.auth)
          .send({}),
      ),
    ];
    const outcomes = await Promise.all([...snapshots, ...api.map((p) => p.then((r) => r.status))]);
    expect(outcomes.filter((o) => o === 500 || o === 503)).toEqual([]);
    expect(Number((await capacity()).reserved)).toBeLessThanOrEqual(1000);
  });
});
