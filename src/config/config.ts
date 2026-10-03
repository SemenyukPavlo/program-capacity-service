import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3410),
    METRICS_PORT: z.coerce.number().int().positive().default(3411),
    LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DATABASE_URL: z.string().url(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(20),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
    RUN_MIGRATIONS: bool.default('true'),

    KAFKA_ENABLED: bool.default('true'),
    KAFKA_BROKERS: csv.default('localhost:9092'),
    KAFKA_CLIENT_ID: z.string().default('program-capacity-service'),
    KAFKA_GROUP_ID: z.string().default('program-capacity-service'),
    KAFKA_TOPIC_PROGRAM_EVENTS: z.string().default('treasury.program-events'),
    KAFKA_TOPIC_RECONCILIATION: z.string().default('treasury.reconciliation'),
    KAFKA_TOPIC_DLQ: z.string().default('treasury.dlq'),
    KAFKA_TOPIC_CAPACITY_EVENTS: z.string().default('capacity.events'),

    AUTH_ISSUER: z.string().min(1),
    AUTH_AUDIENCE: z.string().min(1),
    // Exactly one of the two must be provided.
    AUTH_JWKS_URL: z.string().url().optional(),
    AUTH_PUBLIC_KEY_PEM: z.string().optional(),
    AUTH_CLOCK_TOLERANCE_SEC: z.coerce.number().int().nonnegative().default(30),

    // Static FX rates for local/dev, e.g. "EUR:USD=1.08,GBP:USD=1.27". See FxModule.
    FX_STATIC_RATES: z.string().default(''),
    FX_MAX_RATE_AGE_SEC: z.coerce.number().int().positive().default(3600),

    // Reconciliation drift guard: if |reserved_after - reserved_before| / limit exceeds this ratio,
    // the snapshot is NOT auto-applied and is flagged REQUIRES_REVIEW. 0 disables the guard.
    RECON_MAX_AUTO_DRIFT_RATIO: z.coerce.number().min(0).default(0),

    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  })
  .refine((c) => Boolean(c.AUTH_JWKS_URL) !== Boolean(c.AUTH_PUBLIC_KEY_PEM), {
    message: 'Exactly one of AUTH_JWKS_URL or AUTH_PUBLIC_KEY_PEM must be set',
  });

export type AppConfig = z.infer<typeof schema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
}
