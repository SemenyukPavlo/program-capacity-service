import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { InvalidTokenError, JwtVerifier } from './jwt-verifier';
import { Principal, Scope } from './principal';

const IS_PUBLIC = 'auth:public';
const REQUIRED_SCOPES = 'auth:scopes';

/** Opts a route out of authentication. Only used for liveness/readiness probes. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** All listed scopes are required. */
export const RequireScopes = (...scopes: Scope[]) => SetMetadata(REQUIRED_SCOPES, scopes);

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal,
);

export interface AuthenticatedRequest extends Request {
  principal: Principal;
}

/**
 * Global guard: every route is authenticated unless explicitly marked @Public().
 * Secure-by-default means a newly added endpoint can't accidentally ship unauthenticated.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: JwtVerifier,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    const match = header ? /^Bearer ([A-Za-z0-9\-_.]+)$/.exec(header) : null;
    if (!match) throw new UnauthorizedException('Missing or malformed bearer token');

    try {
      req.principal = await this.verifier.verify(match[1]);
    } catch (err) {
      if (err instanceof InvalidTokenError) throw new UnauthorizedException('Invalid token');
      throw err;
    }

    const required = this.reflector.getAllAndOverride<Scope[]>(REQUIRED_SCOPES, targets) ?? [];
    const missing = required.filter((s) => !req.principal.scopes.has(s));
    if (missing.length) throw new ForbiddenException(`Missing scope(s): ${missing.join(', ')}`);
    return true;
  }
}
