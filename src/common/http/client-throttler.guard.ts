import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limits per authenticated client (`sub`) rather than per IP: behind a proxy or load
 * balancer every caller would otherwise share one IP and one budget. Runs after AuthGuard,
 * so the principal is already resolved; unauthenticated requests fall back to the IP.
 */
@Injectable()
export class ClientThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const subject = (req.principal as { subject?: string } | undefined)?.subject;
    return subject ? `client:${subject}` : `ip:${String(req.ip)}`;
  }
}
