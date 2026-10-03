import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res, Sse, MessageEvent } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import {
  auditTime,
  concat,
  concatMap,
  defer,
  distinctUntilChanged,
  from,
  interval,
  map,
  merge,
  Observable,
} from 'rxjs';
import { CurrentPrincipal, RequireScopes } from '../auth/auth.guard';
import { Principal, Scopes } from '../auth/principal';
import { Errors } from '../common/errors/domain-error';
import { CapacityService, RequestContext } from './capacity.service';
import { CapacityStreamService } from './capacity-stream.service';
import {
  IDEMPOTENCY_KEY_PATTERN,
  id,
  ListLedgerQuery,
  ListReservationsQuery,
  ReleaseDto,
  ReserveDto,
} from './capacity.dto';
import { hashRequest, HttpResult } from './idempotency.service';
import { ReservationResult } from './views';

const HEARTBEAT_MS = 15_000;
const SSE_COALESCE_MS = 100;

const idempotencyHeader = ApiHeader({
  name: 'Idempotency-Key',
  required: false,
  description: 'Client-generated key (8-128 chars). Retries with the same key and body return the original response.',
});

@ApiTags('capacity')
@ApiBearerAuth()
@ApiResponse({ status: 401, description: 'Missing or invalid token' })
@ApiResponse({ status: 403, description: 'Missing scope' })
@Controller({ path: 'programs', version: '1' })
export class CapacityController {
  constructor(
    private readonly service: CapacityService,
    private readonly stream: CapacityStreamService,
  ) {}

  @Get()
  @RequireScopes(Scopes.CAPACITY_READ)
  @ApiOperation({ summary: 'List capacity of all programs the caller can access' })
  async list(@CurrentPrincipal() principal: Principal) {
    return { items: await this.service.listPrograms(principal) };
  }

  @Get(':programId/capacity')
  @RequireScopes(Scopes.CAPACITY_READ)
  @ApiOperation({ summary: 'Current limit, reserved and available capacity' })
  @ApiResponse({ status: 304, description: 'Not modified (If-None-Match matched current version)' })
  async capacity(
    @CurrentPrincipal() principal: Principal,
    @Param('programId') programId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const view = await this.service.getCapacity(principal, validId(programId));
    const etag = `W/"${view.version}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.headers['if-none-match'] === etag) {
      res.status(304);
      return undefined;
    }
    return view;
  }

  @Sse(':programId/capacity/stream')
  @RequireScopes(Scopes.CAPACITY_READ)
  @ApiOperation({
    summary: 'Server-Sent Events stream of capacity changes',
    description: 'Emits the current capacity immediately, then on every change; heartbeat every 15s.',
  })
  async streamCapacity(
    @CurrentPrincipal() principal: Principal,
    @Param('programId') programId: string,
  ): Promise<Observable<MessageEvent>> {
    const pid = validId(programId);
    // Authorise and 404 before the stream opens, so errors are proper HTTP responses.
    await this.service.getCapacity(principal, pid);
    const snapshot = () => defer(() => from(this.service.getCapacity(principal, pid)));
    // A burst of changes is coalesced (latest state wins) instead of one DB read per change.
    const changes = this.stream.forProgram(pid).pipe(auditTime(SSE_COALESCE_MS), concatMap(snapshot));
    const updates = concat(snapshot(), changes).pipe(
      distinctUntilChanged((a, b) => a.version >= b.version),
      map((view): MessageEvent => ({ type: 'capacity', id: String(view.version), data: view })),
    );
    const heartbeat = interval(HEARTBEAT_MS).pipe(map((): MessageEvent => ({ type: 'heartbeat', data: {} })));
    return merge(updates, heartbeat);
  }

  @Post(':programId/reservations')
  @RequireScopes(Scopes.RESERVATIONS_WRITE)
  @idempotencyHeader
  @ApiOperation({ summary: 'Reserve capacity for an invoice approved for early payment' })
  @ApiResponse({ status: 201, description: 'Reservation created' })
  @ApiResponse({ status: 200, description: 'Same invoice and amount already reserved (safe retry)' })
  @ApiResponse({ status: 409, description: 'INSUFFICIENT_CAPACITY, PROGRAM_NOT_ACTIVE, INVOICE_ALREADY_RESERVED' })
  @ApiResponse({ status: 422, description: 'UNSUPPORTED_CURRENCY_PAIR, IDEMPOTENCY_KEY_REUSED' })
  async reserve(
    @CurrentPrincipal() principal: Principal,
    @Param('programId') programId: string,
    @Body() body: ReserveDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const pid = validId(programId);
    const result = await this.service.reserve(principal, pid, body, this.context(req, principal, key, body));
    if (result.status === 201) {
      res.setHeader('Location', `/v1/programs/${pid}/reservations/${encodeURIComponent(body.invoiceId)}`);
    }
    return send(res, result);
  }

  @Get(':programId/reservations')
  @RequireScopes(Scopes.CAPACITY_READ)
  @ApiOperation({ summary: 'List reservations (cursor pagination)' })
  async listReservations(
    @CurrentPrincipal() principal: Principal,
    @Param('programId') programId: string,
    @Query() query: ListReservationsQuery,
  ) {
    return this.service.listReservations(principal, validId(programId), query);
  }

  @Get(':programId/reservations/:invoiceId')
  @RequireScopes(Scopes.CAPACITY_READ)
  @ApiOperation({ summary: 'Get the reservation for an invoice' })
  async getReservation(
    @CurrentPrincipal() principal: Principal,
    @Param('programId') programId: string,
    @Param('invoiceId') invoiceId: string,
  ) {
    return this.service.getReservation(principal, validId(programId), validId(invoiceId));
  }

  @Post(':programId/reservations/:invoiceId/release')
  @RequireScopes(Scopes.RESERVATIONS_RELEASE)
  @idempotencyHeader
  @ApiOperation({
    summary: 'Release capacity on repayment (full, or partial in invoice currency)',
    description: 'Repeating a full release is a no-op. Partial releases should carry an Idempotency-Key.',
  })
  @ApiResponse({ status: 200, description: 'Released (or already released)' })
  @ApiResponse({ status: 422, description: 'RELEASE_EXCEEDS_OUTSTANDING, CURRENCY_MISMATCH' })
  async release(
    @CurrentPrincipal() principal: Principal,
    @Param('programId') programId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() body: ReleaseDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ctx = this.context(req, principal, key, body);
    return send(res, await this.service.release(principal, validId(programId), validId(invoiceId), body, ctx));
  }

  @Post(':programId/reservations/:invoiceId/cancel')
  @RequireScopes(Scopes.RESERVATIONS_RELEASE)
  @idempotencyHeader
  @ApiOperation({ summary: 'Cancel a reservation that was never repaid (e.g. funding withdrawn)' })
  async cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('programId') programId: string,
    @Param('invoiceId') invoiceId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ctx = this.context(req, principal, key, {});
    return send(res, await this.service.cancel(principal, validId(programId), validId(invoiceId), ctx));
  }

  @Get(':programId/ledger')
  @RequireScopes(Scopes.CAPACITY_READ)
  @ApiOperation({ summary: 'Append-only audit trail of capacity movements' })
  async ledger(
    @CurrentPrincipal() principal: Principal,
    @Param('programId') programId: string,
    @Query() query: ListLedgerQuery,
  ) {
    return this.service.listLedger(principal, validId(programId), query);
  }

  private context(req: Request, principal: Principal, key: string | undefined, body: unknown): RequestContext {
    const correlationId = String(req.id ?? '');
    if (key === undefined) return { correlationId };
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw Errors.validation('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9._:-]');
    }
    return {
      correlationId,
      idempotency: { clientId: principal.subject, key, requestHash: hashRequest(req.method, req.path, body) },
    };
  }
}

function send(res: Response, result: HttpResult<ReservationResult>): ReservationResult {
  res.status(result.status);
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return result.body;
}

function validId(value: string): string {
  if (!id.safeParse(value).success) throw Errors.validation('INVALID_ID', `Invalid identifier: ${value}`);
  return value;
}
