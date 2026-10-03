import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const end = this.metrics.httpDuration.startTimer();
    res.on('finish', () => {
      // Route template (e.g. /v1/programs/:programId/capacity) keeps label cardinality bounded.
      const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
      end({ method: req.method, route: `${req.baseUrl}${route}`, status: String(res.statusCode) });
    });
    next();
  }
}
