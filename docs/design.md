# Design notes

Architecture, design decisions, invariants, assumptions and trade-offs of the Program Capacity Service.
How to run it: [README](../README.md). Kafka contracts: [events.md](events.md).

## Architecture

```
            REST / SSE clients                          Treasury system
                    │                                         │
        JWT (RS256, JWKS) + scopes                 Kafka: treasury.program-events
                    │                                     treasury.reconciliation
                    ▼                                         │
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ program-capacity-service (stateless, horizontally scalable)                   │
 │                                                                               │
 │  AuthGuard ─► CapacityController ─► CapacityService ◄── TreasuryConsumer       │
 │                      │                   │   ▲               │ (manual commit, │
 │              CapacityStream (SSE)        │   │               │  DLQ on poison) │
 │                      ▲                   │   └── ReconciliationService         │
 │                      │                   ▼                                    │
 │                 LISTEN/NOTIFY      PostgreSQL ── outbox ──► OutboxRelay ──────┼─► capacity.events
 └──────────────────────────────────────────────────────────────────────────────┘
                                         │
             programs · reservations · ledger_entries (append-only) · processed_messages
             idempotency_keys · reconciliation_runs · outbox
```

- **PostgreSQL is the single source of truth** for this service's state. Every change (capacity
  row, reservation row, ledger entry, outbox event, Kafka de-dup marker, idempotency record)
  commits in **one transaction**, so there are no partial states.
- **The service is stateless.** Any number of replicas can run: correctness comes from row
  locks, SSE fan-out comes from `LISTEN/NOTIFY`, and the outbox relay uses `SKIP LOCKED`.

Code layout:

```
src/
  capacity/        REST controller, service, repository (SQL), idempotency, SSE stream, views
    domain/        pure logic: release/cancel state machine, reconciliation diff (unit-tested)
  treasury/        Kafka consumer, message schemas, handler, reconciliation, outbox relay
  common/money/    Money value object, ISO 4217 currencies
  fx/              FxRateProvider port, static provider, conversion policy
  auth/            JWT verification, global guard, scopes, program access
  common/http/     RFC 7807 problem+json filter
  database/        pool/transactions, SQL migration runner
  observability/   Prometheus metrics
migrations/        versioned SQL
scripts/           dev IdP, token helper, treasury simulator, demo
test/unit, test/integration
```

---

## API

All routes are under `/v1` and require `Authorization: Bearer <JWT>`. The only public routes are
`/health` and `/ready` (see Assumptions). Amounts are always **decimal strings**, never JSON
numbers. Errors use `application/problem+json` (RFC 7807) with a stable `code`.

| Method & path                                          | Scope                  | Notes                                                               |
| ------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------- |
| `GET /programs`                                        | `capacity:read`        | Programs the caller can access                                      |
| `GET /programs/{id}/capacity`                          | `capacity:read`        | `limit`, `reserved`, `available`, `version`; `ETag`/`If-None-Match` |
| `GET /programs/{id}/capacity/stream`                   | `capacity:read`        | SSE: current state, then every change; heartbeat 15s                |
| `POST /programs/{id}/reservations`                     | `reservations:write`   | `{invoiceId, amount, currency}`, optional `Idempotency-Key`         |
| `GET /programs/{id}/reservations`                      | `capacity:read`        | `?status=&order=asc\|desc&limit=&cursor=` (cursor pagination)       |
| `GET /programs/{id}/reservations/{invoiceId}`          | `capacity:read`        |                                                                     |
| `POST /programs/{id}/reservations/{invoiceId}/release` | `reservations:release` | `{}` = full; `{amount, currency}` = partial, in invoice currency    |
| `POST /programs/{id}/reservations/{invoiceId}/cancel`  | `reservations:release` | Only if no repayment happened yet                                   |
| `GET /programs/{id}/ledger`                            | `capacity:read`        | Append-only audit trail; `?order=asc\|desc&limit=&cursor=`          |

Main outcomes:

| Status    | Code                                                                                                                             | When                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 201       | —                                                                                                                                | Reservation created (with `Location`)                                                         |
| 200       | —                                                                                                                                | Same invoice + same amount already reserved (safe retry); release/cancel (also when repeated) |
| 400       | `VALIDATION_FAILED`, `INVALID_AMOUNT`, `INVALID_AMOUNT_SCALE`, `UNSUPPORTED_CURRENCY`                                            | Malformed input                                                                               |
| 401 / 403 | `UNAUTHENTICATED` / `FORBIDDEN`                                                                                                  | Bad token / missing scope                                                                     |
| 404       | `PROGRAM_NOT_FOUND`, `RESERVATION_NOT_FOUND`                                                                                     | Also returned for programs the caller may not see                                             |
| 409       | `INSUFFICIENT_CAPACITY` (+ `available`), `PROGRAM_NOT_ACTIVE`, `INVOICE_ALREADY_RESERVED`, `INVALID_STATE_TRANSITION`            | Business conflicts                                                                            |
| 422       | `UNSUPPORTED_CURRENCY_PAIR`, `AMOUNT_OUT_OF_RANGE`, `RELEASE_EXCEEDS_OUTSTANDING`, `CURRENCY_MISMATCH`, `IDEMPOTENCY_KEY_REUSED` | Valid shape, can't be processed                                                               |
| 413 / 429 | `PAYLOAD_TOO_LARGE` (body > 100 KB) / `RATE_LIMITED` (per client `sub`)                                                          | Limits                                                                                        |
| 503       | `FX_RATE_STALE`, `TEMPORARILY_UNAVAILABLE`                                                                                       | Retryable (`Retry-After`)                                                                     |

Every response carries `X-Request-Id`. An inbound id is honoured, otherwise one is generated. It
is written to the logs and to `ledger_entries.correlation_id`.

---

## How the hard parts are handled

### 1. Concurrency: capacity can never be over-allocated

The check and the write are one atomic statement:

```sql
UPDATE programs SET reserved_amount = reserved_amount + $amount, version = version + 1
 WHERE id = $id AND status = 'ACTIVE' AND currency = $ccy
   AND limit_amount - reserved_amount >= $amount
RETURNING ...
```

The row lock serialises concurrent writers on a program. Under READ COMMITTED, PostgreSQL
re-evaluates the `WHERE` against the latest committed row, so two requests can't both see the
same headroom. Zero rows updated triggers a second read that explains why (404 / not active /
insufficient). Every write path takes locks in the same order, **program → reservation(s)**
(reserve, release, cancel, treasury events, reconciliation), so deadlocks can't happen between
them. `lock_timeout` and `statement_timeout` bound waiting time. Deadlocks and serialization
failures are retried with jitter.

Tested with 50 parallel reservations against a limit that fits exactly 10, parallel duplicates,
parallel reserve and release, and reconciliation running alongside API traffic. After every
integration test the suite asserts
`programs.reserved_amount == Σ outstanding reservations == Σ ledger deltas`.

### 2. Idempotency at three layers

- **Business key:** `UNIQUE (program_id, invoice_id)`. Re-reserving the same invoice with the same
  amount returns the existing reservation (200). A different amount returns 409. Concurrent
  first-time duplicates lose on the constraint, which rolls back their capacity increment too.
- **`Idempotency-Key` header:** stored per client in the **same transaction** as the change. A
  concurrent request with the same key blocks on the primary key and then replays the committed
  response (`Idempotent-Replayed: true`). Reusing a key with a different body returns 422. Failed
  requests roll back, so they aren't cached and a retry re-evaluates; for example, capacity may
  have been released in the meantime.
- **State machine:** a repeated full release or cancel is a no-op. Partial releases aren't
  naturally idempotent, so clients should send an `Idempotency-Key`.

### 3. Money and currencies

- `Money` value object backed by decimal.js; `NUMERIC` in PostgreSQL; strings on the wire.
  Exponents, signs, whitespace and JSON numbers are rejected.
- ISO 4217 whitelist with minor units (JPY 0, USD 2, KWD 3). Too many decimals is a 400, never a
  silent rounding.
- **FX is locked at reservation time.** The reservation stores the original invoice amount and
  currency, the converted program amount, the rate, its source and timestamp. Conversion rounds
  **up**, so the program never under-reserves.
- **Releases never re-convert at today's rate.** Partial repayments, in invoice currency, are
  converted proportionally to the outstanding amounts and rounded **down**. The final release
  takes the exact remainder, so rounding can't leak or leave dust. A property-based test checks
  this.
- The rate is fetched **before** the DB transaction (a real provider is a network call). Stale
  rates (`FX_MAX_RATE_AGE_SEC`) are refused with 503.
- Program currency is immutable once the program has reservations.

### 4. Kafka: effectively-once over at-least-once

- Topics are keyed by `programId`, so messages for a program stay ordered within a partition. A
  per-program, strictly increasing **`seq`** (shared by all treasury message types) also orders
  messages _across_ topics.
- Processing is **one DB transaction**: insert into `processed_messages(eventId)`, lock the
  program, apply, record the outcome. The **offset is committed only after** that commit. A crash
  in between redelivers the message, and the redelivery is detected as `duplicate`.
- Messages with `seq <= last applied` are `stale` and ignored. A gap (`seq > last + 1`) is applied
  and counted (`treasury_sequence_gaps_total`), because the next snapshot is authoritative anyway.
- **Poison messages** (invalid JSON or schema, unknown type, rejected by a domain rule) go to
  `treasury.dlq` with `x-original-topic/partition/offset` and `x-error` headers. The offset is then
  committed and the partition keeps flowing.
- **Transient failures** (DB down) retry the same message with capped exponential backoff and
  heartbeats. The partition is blocked on purpose: skipping a message would break ordering.

### 5. Bulk reconciliation

A `PROGRAM_SNAPSHOT` carries treasury's full view of a program: limit, status and every open
reservation with its outstanding amount in program currency, as of `asOf`. It's applied in one
transaction with the program and all relevant reservations locked:

| Local state vs snapshot                                               | Action                                             | Recorded as           |
| --------------------------------------------------------------------- | -------------------------------------------------- | --------------------- |
| Same outstanding                                                      | nothing                                            | —                     |
| Different outstanding                                                 | set to treasury value (may re-open a released one) | `AMOUNT_MISMATCH`     |
| Open locally, absent in snapshot, last local change **before** `asOf` | close                                              | `MISSING_IN_TREASURY` |
| Open in snapshot, unknown locally                                     | create (`source=RECONCILIATION`)                   | `MISSING_LOCALLY`     |
| Local change **after** `asOf`                                         | **keep**: the snapshot predates it                 | `kept`                |

After applying, `reserved_amount` is **recomputed from the rows**, not adjusted incrementally. If
the stored aggregate had drifted from its rows (a bug or a manual edit), the correction is
recorded as `INTERNAL_AGGREGATE_DRIFT` instead of being hidden. Every change produces a
`RECON_ADJUSTMENT` ledger entry, and each run is stored in `reconciliation_runs` with
before/after totals and the discrepancy list. Metrics: `reconciliation_runs_total`,
`reconciliation_discrepancies_total{reason}`, `reconciliation_last_drift_amount`.

There's an optional **drift guard**: with `RECON_MAX_AUTO_DRIFT_RATIO`, a snapshot that would
move utilisation by more than that share of the limit is **not applied**. It's stored as
`REQUIRES_REVIEW` for an operator.

### 6. Limits below utilisation

Treasury may lower a limit below what's already reserved. This is accepted: `available` becomes
negative, existing reservations stay valid, and new reservations are refused until repayments
restore headroom. That's why the schema has a `reserved >= 0` constraint but no
`reserved <= limit` constraint.

### 7. Authentication and authorization

- OAuth2 bearer JWTs, asymmetric only (RS256/ES256). Remote JWKS with caching and rotation, or a
  static public key. `iss`, `aud`, `exp` and `nbf` are verified with a small clock tolerance.
  `alg: none` and HS/RS key confusion are rejected.
- **Secure by default:** the guard is global and every route requires auth unless it is
  explicitly `@Public()`.
- **Scopes** per operation, and a **`programs` claim** for tenant isolation. Programs the caller
  can't access return **404** rather than 403, so ids aren't leaked.
- The caller (`sub`) is recorded as actor on reservations and ledger entries. The
  `Authorization` header is redacted from logs.
- Locally, a tiny **dev IdP** container issues client-credentials tokens and serves JWKS, which
  is the same verification path as production. Clients are listed in `scripts/dev-clients.json`.

### 8. Real-time and integration events

- `pg_notify` is issued inside the writing transaction, so it's delivered only on commit and to
  every replica. Each replica's SSE endpoint pushes the new capacity to its subscribers.
- A **transactional outbox** publishes `CAPACITY_CHANGED` events to `capacity.events` for other
  services, with no dual-write problem. Delivery is at-least-once; consumers dedupe by `eventId`
  and order by `version`.

---

## Invariants

1. `programs.reserved_amount = Σ reservations.outstanding_program_amount` for the program.
2. `Σ ledger_entries.reserved_delta = programs.reserved_amount`. The ledger is append-only, and a
   DB trigger blocks UPDATE and DELETE.
3. A reservation is only created when `limit − reserved ≥ amount` at commit time.
4. `0 ≤ outstanding ≤ original amount` for API-driven changes. Only reconciliation may override
   it, and it is always audited.
5. One reservation per `(program, invoice)`.
6. A release never returns more program capacity than was reserved for that invoice.
7. Allowed transitions: `RESERVED → PARTIALLY_RELEASED → RELEASED`, and `RESERVED → CANCELLED`.
   Reconciliation is the only path allowed to re-open a reservation.

---

## Assumptions

1. **Treasury owns programs** (creation, limit, status, currency) and is authoritative in
   reconciliation. This service owns reservations between snapshots.
2. Snapshots list **individual open reservations**, with amounts in program currency. If treasury
   could only send an aggregate, the fallback would be
   `reserved = treasury_utilised + local changes after asOf` (not implemented).
3. Treasury provides a per-program monotonically increasing `seq` across all its message types,
   plus a unique `eventId`.
4. **Partial repayments** are supported and expressed in invoice currency.
5. An invoice is financed at most once per program: a released or cancelled invoice can't be
   re-reserved.
6. Reservations are allowed only on `ACTIVE` programs. Releases are allowed in any status,
   because repayments still happen on suspended or closed programs.
7. Locally, FX rates come from static config. In production, `FxRateProvider` would be backed by
   the treasury rate feed or a market data vendor. Revaluing open foreign-currency exposure is out
   of scope: it would arrive through reconciliation.
8. "All endpoints must be authenticated" applies to business endpoints. `/health` and `/ready`
   stay unauthenticated for orchestrator probes and expose no data. `/metrics` is served on a
   separate internal port.
9. Insufficient capacity returns **409** because the request is valid but conflicts with current
   state. 422 is used for requests that are well formed but semantically impossible.
10. Per-invoice and per-supplier sub-limits, reservation expiry (TTL) and approval workflows are
    out of scope.

## Trade-offs

| Decision                                                    | Alternative                                                | Why                                                                                                                                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Row lock + conditional UPDATE in PostgreSQL                 | Single writer per program (actor / Kafka partition), Redis | Simple, provably correct, durable; contention is per program only. A single-writer design scales better for one very hot program but adds a lot of machinery.                |
| Materialised `reserved_amount` + reservation rows + ledger  | Event sourcing                                             | O(1) reads and an audit trail without rebuilding projections. Reconciliation recomputes the aggregate from rows, which self-heals drift.                                     |
| Reconciliation watermark = `last_local_change_at` vs `asOf` | Treasury echoes the last local event/offset it saw         | Works without treasury changes but depends on clocks being in sync (NTP, ms precision is plenty). The echo watermark is clock-free and preferred if treasury can support it. |
| SSE (+ ETag polling)                                        | WebSockets                                                 | One-way updates are all that's needed. SSE works through proxies, auto-reconnects and uses plain HTTP auth.                                                                  |
| Error responses are not stored under an `Idempotency-Key`   | Cache every response (Stripe-style)                        | Retrying after `INSUFFICIENT_CAPACITY` should succeed once capacity frees up.                                                                                                |
| Block the partition on transient errors                     | Retry topic                                                | Preserves per-program ordering, which matters more here than throughput.                                                                                                     |
| kafkajs                                                     | confluent-kafka-javascript (librdkafka)                    | Pure JS and easy to run locally; for production I'd evaluate the Confluent client, since kafkajs is in low-maintenance mode.                                                 |
| Dev IdP container                                           | Keycloak                                                   | Seconds to start, same JWKS/RS256 path as production. Swapping in Keycloak or Auth0 is a config change (`AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`).                    |
| Raw SQL (`pg`)                                              | ORM                                                        | The concurrency-critical statements are explicit and reviewable.                                                                                                             |

## Production next steps

- Kafka SASL/SCRAM or mTLS and ACLs; Postgres TLS; secrets from a vault.
- Schema Registry (Avro/Protobuf) for treasury contracts. Chunked or claim-check snapshots for
  very large programs (current cap: 200k reservations, 10 MB).
- A real FX provider with rate caching and staleness alerts.
- An echo watermark from treasury to remove the clock dependency in reconciliation.
- OpenTelemetry tracing (HTTP → DB → Kafka). Alerts on DLQ > 0, reconciliation drift > 0,
  consumer lag, `REQUIRES_REVIEW` runs, and capacity below a threshold.
- Distributed rate limiting (Redis). The current throttler counts per client (`sub`) but per instance.
- Retention jobs for `idempotency_keys`, `processed_messages` and the published `outbox`.
- An operator API to review or approve `REQUIRES_REVIEW` reconciliations and replay the DLQ.
