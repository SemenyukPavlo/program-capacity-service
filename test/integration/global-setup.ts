import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../../src/database/migrate';

declare global {
  var __PG__: StartedPostgreSqlContainer | undefined;
}

export default async function globalSetup(): Promise<void> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  globalThis.__PG__ = container;
  process.env.TEST_DATABASE_URL = container.getConnectionUri();
  await runMigrations(process.env.TEST_DATABASE_URL);
}
