/**
 * DEVELOPMENT-ONLY OAuth2 authorization server (client_credentials grant + JWKS).
 * Stands in for Keycloak/Auth0/Azure AD so the service can be run locally with real RS256
 * tokens validated against a JWKS endpoint — the same code path as production.
 * The signing key is generated in memory on every start and never leaves the process.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import clients from './dev-clients.json';

interface DevClient {
  secret: string;
  scopes: string[];
  programs: string[] | '*';
}

const PORT = Number(process.env.PORT ?? 3412);
const ISSUER = process.env.AUTH_ISSUER ?? 'http://dev-idp.local';
const AUDIENCE = process.env.AUTH_AUDIENCE ?? 'program-capacity-api';
const TTL_SEC = Number(process.env.TOKEN_TTL_SEC ?? 3600);

async function main(): Promise<void> {
  const kid = randomUUID();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }] };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => json(res, 500, { error: 'server_error' }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/.well-known/jwks.json') return json(res, 200, jwks);
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok' });
    if (req.method !== 'POST' || req.url !== '/oauth/token') return json(res, 404, { error: 'not_found' });

    const params = await readParams(req);
    if (params.grant_type !== 'client_credentials') return json(res, 400, { error: 'unsupported_grant_type' });
    const client = (clients as Record<string, DevClient>)[params.client_id ?? ''];
    if (!client || !safeEqual(client.secret, params.client_secret ?? '')) {
      return json(res, 401, { error: 'invalid_client' });
    }
    // Requested scopes are intersected with what the client is allowed (default: all allowed).
    const requested = params.scope?.split(' ').filter(Boolean);
    const scopes = requested ? requested.filter((s) => client.scopes.includes(s)) : client.scopes;

    const token = await new SignJWT({ scope: scopes.join(' '), programs: client.programs })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(params.client_id!)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${TTL_SEC}s`)
      .sign(privateKey);
    return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: TTL_SEC, scope: scopes.join(' ') });
  }

  server.listen(PORT, () => console.log(`dev-idp listening on :${PORT} (issuer ${ISSUER}, audience ${AUDIENCE})`));
  process.once('SIGTERM', () => server.close());
}

async function readParams(req: IncomingMessage): Promise<Record<string, string | undefined>> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) break;
  }
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    try {
      return JSON.parse(body) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

void main();
