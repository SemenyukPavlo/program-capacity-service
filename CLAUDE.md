# CLAUDE.md

Program Capacity & Invoice Reservation service (hiring take-home). NestJS + TypeScript, PostgreSQL, Kafka.
How to run: `README.md`. Design rationale, assumptions and trade-offs: `docs/design.md`; Kafka contracts in `docs/events.md`.

## Commands

Node 22 is required (`.nvmrc`). With nvm: `nvm use` (system Node 20.18 breaks Testcontainers 12 / undici).

```bash
npm start                 # docker compose up -d --build: whole stack: Postgres, Kafka + topics, dev IdP, app, seed programs via Kafka
npm stop                  # docker compose down (add -v manually to wipe volumes)
docker compose run --rm seed snapshot PRG-USD-001 USD 9000000.00 INV-1=100.00   # treasury simulator (see scripts/produce.ts)

npm ci
npm run lint              # typecheck + eslint + prettier --check
npm test                  # unit (no Docker)
npm run test:int          # integration: Testcontainers Postgres + Kafka (Docker required)
npx jest --selectProjects integration --runInBand test/integration/<file>   # single file
```

Host ports (non-default on purpose): API 3410, metrics 3411, dev IdP 3412, Postgres 3413, Kafka 3414, Kafka UI 3415,
Playground UI 3416 (`playground/`: static page + nginx proxy to app, dev IdP and `treasury-sim` = `produce.ts serve`).

Run all three static checks plus both test suites before reporting work as done.

## Layout

Nest modules per folder (`*.module.ts`): `ConfigModule`, `DatabaseModule`, `ObservabilityModule` (global), `AuthModule`,
`FxModule`, `CapacityModule`, `TreasuryModule` (imports Capacity), `HealthModule`. `AppModule` only composes them and
registers the global guards (Auth, then Throttler), the zod pipe and the problem+json filter.

- `src/capacity/` – REST controller, `CapacityService`, `CapacityRepository` (raw SQL), idempotency, SSE stream, response views.
- `src/capacity/domain/` – pure logic (release/cancel state machine, reconciliation diff). No I/O; unit-tested.
- `src/treasury/` – Kafka consumer, zod message schemas, `TreasuryHandler`, `ReconciliationService`, outbox relay.
- `src/common/money/` – `Money` value object + ISO 4217 whitelist. `src/fx/` – `FxRateProvider` port + conversion policy.
- `src/auth/` – JWT verification (jose), global `AuthGuard`, scopes, program access.
- `migrations/*.sql` – applied in order on startup by `src/database/migrate.ts`. Never edit an applied migration; add a new file.
- `scripts/` – dev IdP (+ `dev-clients.json`) and the treasury simulator `produce.ts`; both run as compose services. `test/unit`, `test/integration` (`helpers.ts` has setup/fixtures).

## Rules that must not be broken

- **Money**: never `number`. Use `Money` / decimal.js, `NUMERIC` in SQL, strings in JSON. Respect currency minor units.
- **Capacity changes** go through one DB transaction that updates `programs`, the reservation row, inserts a
  `ledger_entries` row and calls `recordCapacityChange` (outbox + pg_notify). Keep the invariant
  `programs.reserved_amount == Σ outstanding_program_amount == Σ ledger reserved_delta` (`assertInvariants` in tests).
- **Lock order** is always program → reservation(s). Reservation check-and-write stays a single conditional `UPDATE`.
- **FX** is fetched before the transaction; releases use the stored converted amount, never a fresh rate.
- `ledger_entries` is append-only (DB trigger). No `reserved <= limit` constraint: limits may drop below utilisation.
- **Auth** is secure-by-default: new routes need `@RequireScopes(...)` and `assertProgramAccess`; only probes are `@Public()`.
- Domain errors: throw `Errors.*` (`DomainError`), never Nest HTTP exceptions, from services/domain. Details must not
  use keys that clash with problem+json members (`status`, `code`, `type`, `title`, `detail`).
- Kafka handlers must stay idempotent (`processed_messages`) and respect per-program `seq`; domain rejections become DLQ.

## Gotchas

- Do not run Nest code with `tsx`/esbuild: it doesn't emit decorator metadata (DI and Swagger break).
  Use `npm run start:dev` (ts-node) or the compiled build. `tsx` is fine for `scripts/` (no decorators).
- Integration tests bind the app to a random port (`app.listen(0)`); log level is `silent` — temporarily raise
  `LOG_LEVEL` in `setup()` env when debugging.
- If a request hangs in tests, check the exception filter path first (an error while rendering = no response).
- Prettier: single quotes, trailing commas, width 120. ESLint forbids `any`, floating promises and `console` in `src/`.
