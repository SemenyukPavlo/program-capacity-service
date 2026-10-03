import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, importSPKI, JWTPayload, jwtVerify, KeyLike } from 'jose';
import { APP_CONFIG, AppConfig } from '../config/config';
import { Principal } from './principal';

// Asymmetric algorithms only: rules out `alg: none` and HS256/RS256 key-confusion attacks.
const ALLOWED_ALGORITHMS = ['RS256', 'ES256'];

type KeySource = KeyLike | ReturnType<typeof createRemoteJWKSet>;

export class InvalidTokenError extends Error {}

@Injectable()
export class JwtVerifier {
  private keySource?: Promise<KeySource>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      const key = await this.getKey();
      ({ payload } = await jwtVerify(token, key as Parameters<typeof jwtVerify>[1], {
        issuer: this.config.AUTH_ISSUER,
        audience: this.config.AUTH_AUDIENCE,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: this.config.AUTH_CLOCK_TOLERANCE_SEC,
        requiredClaims: ['sub', 'exp'],
      }));
    } catch (err) {
      throw new InvalidTokenError((err as Error).message);
    }
    return toPrincipal(payload);
  }

  private getKey(): Promise<KeySource> {
    // Remote JWKS is cached by jose and refetched on unknown `kid` (key rotation).
    this.keySource ??= this.config.AUTH_JWKS_URL
      ? Promise.resolve(createRemoteJWKSet(new URL(this.config.AUTH_JWKS_URL), { cooldownDuration: 30_000 }))
      : importSPKI(this.config.AUTH_PUBLIC_KEY_PEM!.replace(/\\n/g, '\n'), 'RS256');
    return this.keySource;
  }
}

function toPrincipal(payload: JWTPayload): Principal {
  const rawScope = payload.scope ?? payload.scp;
  const scopes = Array.isArray(rawScope)
    ? rawScope.map(String)
    : typeof rawScope === 'string'
      ? rawScope.split(' ').filter(Boolean)
      : [];

  const rawPrograms = payload.programs;
  let programs: Principal['programs'];
  if (rawPrograms === '*') programs = '*';
  else if (Array.isArray(rawPrograms)) programs = new Set(rawPrograms.map(String));
  else programs = new Set();

  return { subject: payload.sub!, scopes: new Set(scopes), programs };
}
