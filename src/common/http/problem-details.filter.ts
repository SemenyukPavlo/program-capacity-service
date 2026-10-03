import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import { DomainError, DomainErrorKind } from '../errors/domain-error';

const STATUS_BY_KIND: Record<DomainErrorKind, number> = {
  VALIDATION: HttpStatus.BAD_REQUEST,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  UNPROCESSABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
};

// PostgreSQL errors that mean "busy, try again" rather than a bug.
const RETRYABLE_PG = new Set([
  '55P03' /* lock_not_available */,
  '57014' /* query_canceled (timeout) */,
  '40001',
  '40P01',
]);

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  requestId?: string;
  [extra: string]: unknown;
}

/**
 * Renders every error as RFC 7807 application/problem+json with a stable machine-readable
 * `code`. Internal errors never leak messages or stack traces to the client.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    if (res.headersSent) return; // e.g. an SSE stream that already started
    let problem: Problem;
    try {
      problem = this.toProblem(exception);
    } catch (mappingError) {
      this.logger.error({ err: mappingError }, 'Failed to map exception');
      problem = { ...internalProblem() };
    }
    problem.instance = req.originalUrl;
    problem.requestId = String(req.id ?? '');

    if (problem.status >= 500) {
      this.logger.error({ err: exception, requestId: problem.requestId }, 'Request failed');
    }
    if (problem.status === 503) res.setHeader('Retry-After', '1');
    res.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(e: unknown): Problem {
    if (e instanceof DomainError) {
      const status = STATUS_BY_KIND[e.kind];
      // Standard members always win over details, so a detail can never change e.g. `status`.
      return { ...(e.details ?? {}), ...problem(status, e.code, e.message) };
    }
    if (e instanceof ZodValidationException) {
      const zodError = e.getZodError() as ZodError;
      return {
        ...problem(400, 'VALIDATION_FAILED', 'Request validation failed'),
        errors: zodError.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const body = e.getResponse();
      const message = typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? e.message);
      return problem(status, codeForStatus(status), Array.isArray(message) ? message.join('; ') : String(message));
    }
    // Errors raised by Express middleware before Nest (e.g. body-parser: entity.too.large,
    // entity.parse.failed, encoding.unsupported) follow the http-errors shape.
    const httpError = e as { status?: unknown; expose?: unknown; type?: unknown; message?: unknown };
    if (typeof httpError?.status === 'number' && httpError.expose === true && httpError.status < 500) {
      const code = httpError.type === 'entity.parse.failed' ? 'INVALID_JSON' : codeForStatus(httpError.status);
      return problem(httpError.status, code, String(httpError.message ?? 'Bad request'));
    }
    const pgCode = (e as { code?: string })?.code;
    if (pgCode && RETRYABLE_PG.has(pgCode)) {
      return problem(503, 'TEMPORARILY_UNAVAILABLE', 'The resource is busy; retry the request');
    }
    return internalProblem();
  }
}

function internalProblem(): Problem {
  return problem(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

function problem(status: number, code: string, detail: string): Problem {
  return {
    type: `https://errors.program-capacity.local/${code.toLowerCase().replace(/_/g, '-')}`,
    title: STATUS_CODES[status] ?? 'Error',
    status,
    code,
    detail,
  };
}

function codeForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
  }
}
