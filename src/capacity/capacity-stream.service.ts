import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Client } from 'pg';
import { Observable, Subject, filter, map } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config/config';

export interface CapacityChanged {
  programId: string;
  version: number;
}

/**
 * Fans out capacity changes to SSE subscribers. Changes are published with pg_notify inside the
 * writing transaction, so every replica's LISTEN connection receives them only after commit —
 * clients connected to any instance see changes made by any instance.
 */
@Injectable()
export class CapacityStreamService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CapacityStreamService.name);
  private readonly changes = new Subject<CapacityChanged>();
  private client?: Client;
  private stopped = false;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  forProgram(programId: string): Observable<number> {
    return this.changes.pipe(
      filter((c) => c.programId === programId),
      map((c) => c.version),
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({ connectionString: this.config.DATABASE_URL });
    client.on('notification', (n) => {
      try {
        this.changes.next(JSON.parse(n.payload ?? '') as CapacityChanged);
      } catch {
        this.logger.warn({ payload: n.payload }, 'Ignoring malformed capacity notification');
      }
    });
    // A dropped connection may surface as 'error', 'end' or both; reconnect exactly once.
    let reconnecting = false;
    const reconnect = (reason: string, err?: unknown) => {
      if (reconnecting || this.stopped) return;
      reconnecting = true;
      this.logger.error({ err, reason }, 'LISTEN connection lost; reconnecting');
      void client.end().catch(() => undefined);
      setTimeout(() => void this.connect().catch(() => undefined), 1000);
    };
    client.on('error', (err) => reconnect('error', err));
    client.on('end', () => reconnect('end'));
    try {
      await client.connect();
      await client.query('LISTEN capacity_changed');
      this.client = client;
    } catch (err) {
      reconnect('connect failed', err);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.changes.complete();
    await this.client?.end().catch(() => undefined);
  }
}
