import { generateKeyPair } from 'jose';
import { createProgram, resetDb, setup, TestContext } from './helpers';

jest.setTimeout(30_000);

describe('Authentication & authorization', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setup();
    await resetDb(ctx.pool);
    await createProgram(ctx, 'P-A', 'USD', '1000.00');
    await createProgram(ctx, 'P-B', 'USD', '1000.00');
  });
  afterAll(() => ctx.close());

  const get = (path: string, token?: string) => {
    const req = ctx.http().get(path);
    return token === undefined ? req : req.set('Authorization', token);
  };

  const protectedRoutes: [string, string][] = [
    ['get', '/v1/programs'],
    ['get', '/v1/programs/P-A/capacity'],
    ['get', '/v1/programs/P-A/capacity/stream'],
    ['get', '/v1/programs/P-A/reservations'],
    ['get', '/v1/programs/P-A/reservations/X'],
    ['get', '/v1/programs/P-A/ledger'],
    ['post', '/v1/programs/P-A/reservations'],
    ['post', '/v1/programs/P-A/reservations/X/release'],
    ['post', '/v1/programs/P-A/reservations/X/cancel'],
  ];

  it.each(protectedRoutes)('%s %s requires a token (401)', async (method, path) => {
    const res = await (method === 'get' ? ctx.http().get(path) : ctx.http().post(path).send({})).expect(401);
    expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('health and readiness probes are public', async () => {
    await ctx.http().get('/health').expect(200);
    await ctx.http().get('/ready').expect(200);
  });

  it.each([
    ['malformed header', async () => 'Token abc'],
    ['garbage token', async () => 'Bearer not.a.jwt'],
    ['expired', async () => `Bearer ${await ctx.token({ expiresIn: '-1m' })}`],
    ['wrong issuer', async () => `Bearer ${await ctx.token({ issuer: 'https://evil.example' })}`],
    ['wrong audience', async () => `Bearer ${await ctx.token({ audience: 'other-api' })}`],
    [
      'signed by another key',
      async () => `Bearer ${await ctx.token({ key: (await generateKeyPair('RS256')).privateKey })}`,
    ],
    [
      'alg=none',
      async () => {
        const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        return `Bearer ${enc({ alg: 'none' })}.${enc({ sub: 'x', iss: 'https://idp.test', aud: 'program-capacity-api', exp: now + 60, scope: 'capacity:read', programs: '*' })}.`;
      },
    ],
  ])('rejects %s with 401', async (_, header) => {
    await get('/v1/programs/P-A/capacity', await header()).expect(401);
  });

  it('403 when a scope is missing', async () => {
    const readOnly = `Bearer ${await ctx.token({ scope: 'capacity:read' })}`;
    await get('/v1/programs/P-A/capacity', readOnly).expect(200);
    const res = await ctx
      .http()
      .post('/v1/programs/P-A/reservations')
      .set('Authorization', readOnly)
      .send({ invoiceId: 'I', amount: '1.00', currency: 'USD' })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    await ctx
      .http()
      .post('/v1/programs/P-A/reservations/I/release')
      .set('Authorization', readOnly)
      .send({})
      .expect(403);
  });

  it('program-scoped clients see only their programs; others look like 404', async () => {
    const scoped = `Bearer ${await ctx.token({ programs: ['P-A'] })}`;
    await get('/v1/programs/P-A/capacity', scoped).expect(200);
    const res = await get('/v1/programs/P-B/capacity', scoped).expect(404);
    expect(res.body.code).toBe('PROGRAM_NOT_FOUND');
    await ctx
      .http()
      .post('/v1/programs/P-B/reservations')
      .set('Authorization', scoped)
      .send({ invoiceId: 'I', amount: '1.00', currency: 'USD' })
      .expect(404);
    const list = await get('/v1/programs', scoped).expect(200);
    expect(list.body.items.map((p: { programId: string }) => p.programId)).toEqual(['P-A']);
  });

  it('a token without a programs claim has access to nothing', async () => {
    const none = `Bearer ${await ctx.token({ programs: [] })}`;
    await get('/v1/programs/P-A/capacity', none).expect(404);
  });

  describe('rate limiting', () => {
    let limited: TestContext;
    beforeAll(async () => {
      limited = await setup({ RATE_LIMIT_PER_MINUTE: '3' });
    });
    afterAll(() => limited.close());

    it('is tracked per client, not per IP', async () => {
      const a = { Authorization: `Bearer ${await limited.token({ sub: 'client-a' })}` };
      const b = { Authorization: `Bearer ${await limited.token({ sub: 'client-b' })}` };
      for (let i = 0; i < 3; i++) await limited.http().get('/v1/programs').set(a).expect(200);
      const res = await limited.http().get('/v1/programs').set(a).expect(429);
      expect(res.body.code).toBe('RATE_LIMITED');
      // Same IP, different client: has its own budget.
      await limited.http().get('/v1/programs').set(b).expect(200);
    });
  });
});
