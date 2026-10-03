# Program Capacity Service

Tracks a financing program's credit capacity in real time: invoice reservations, repayments (releases) and treasury
updates/reconciliation via Kafka. NestJS + TypeScript, PostgreSQL, Kafka.

- Design, assumptions and trade-offs: [docs/design.md](docs/design.md)
- Kafka message contracts: [docs/events.md](docs/events.md)

## Run

Requires Docker (and Node/npm for the `npm` shortcuts; plain `docker compose up -d` works too).

```bash
npm start     # = docker compose up -d --build
npm stop      # = docker compose down (keeps data; `docker compose down -v` also wipes the database)
```

This builds and starts everything: PostgreSQL (migrations run on app start), Kafka with its topics, a dev OAuth2
identity provider and the app. It then seeds three programs through Kafka, the same way the treasury system would.
The first start takes about a minute; later starts rebuild only what changed.

| Service                                           | URL                           |
| ------------------------------------------------- | ----------------------------- |
| **Playground UI** (try everything in the browser) | http://localhost:3416         |
| API                                               | http://localhost:3410/v1      |
| Swagger UI                                        | http://localhost:3410/docs    |
| Prometheus metrics                                | http://localhost:3411/metrics |
| Dev IdP (OAuth2 client credentials + JWKS)        | http://localhost:3412         |
| PostgreSQL                                        | localhost:3413                |
| Kafka (host listener)                             | localhost:3414                |
| Kafka UI (`docker compose --profile ui up`)       | http://localhost:3415         |

Seeded programs: `PRG-USD-001` (USD 10,000,000), `PRG-EUR-001` (EUR 5,000,000), `PRG-JPY-001` (JPY 1,000,000,000).

## Try it

The easiest way is the **Playground** at http://localhost:3416. Pick who you act as and which program, then use
three tabs: **Reservations** (reserve, repay, cancel; advanced: Idempotency-Key and parallel load test), **Treasury**
(limit/status changes, repayments, reconciliation snapshots and Kafka delivery tests) and **Ledger**. Capacity updates
live, and every API call is listed under **Requests**.

The same from the terminal:

Get a token. The dev clients are in `scripts/dev-clients.json`: `ops-console` has all scopes and all programs,
`supplier-portal` is limited to two programs, and `dashboard` is read-only.

```bash
TOKEN=$(curl -s localhost:3412/oauth/token -d grant_type=client_credentials \
  -d client_id=ops-console -d client_secret=ops-console-dev-secret | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
API=localhost:3410/v1/programs/PRG-USD-001
```

```bash
# capacity
curl -H "Authorization: Bearer $TOKEN" $API/capacity

# reserve an EUR invoice on the USD program (FX locked at reservation time)
curl -X POST $API/reservations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: inv-1001-attempt' -d '{"invoiceId":"INV-1001","amount":"100000.00","currency":"EUR"}'

# partial repayment in invoice currency; send {} for full repayment
curl -X POST $API/reservations/INV-1001/release -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"amount":"40000.00","currency":"EUR"}'

# live updates (Server-Sent Events)
curl -N -H "Authorization: Bearer $TOKEN" $API/capacity/stream

# audit trail
curl -H "Authorization: Bearer $TOKEN" $API/ledger
```

Send treasury messages through Kafka:

```bash
docker compose run --rm seed program  PRG-USD-001 USD 12000000.00                  # limit change
docker compose run --rm seed release  PRG-USD-001 INV-1001                         # repayment seen by treasury
docker compose run --rm seed snapshot PRG-USD-001 USD 9000000.00 INV-1001=50000.00 # full-state reconciliation
docker compose run --rm seed duplicate PRG-USD-001                                 # same event twice -> applied once
docker compose run --rm seed stale PRG-USD-001                                     # old sequence -> ignored
docker compose run --rm seed poison                                                # invalid message -> treasury.dlq
```

## Development

Requires Node 22 (`nvm use`).

| Command             | What it does                                                                 |
| ------------------- | ---------------------------------------------------------------------------- |
| `npm ci`            | Install dependencies                                                         |
| `npm test`          | Unit tests (no Docker needed)                                                |
| `npm run test:int`  | Integration tests against real PostgreSQL and Kafka (Testcontainers, Docker) |
| `npm run lint`      | Typecheck + ESLint + Prettier check                                          |
| `npm run format`    | Format all files with Prettier                                               |
| `npm run start:dev` | Run the app on the host in watch mode (env: see `.env.example`)              |
| `npm run build`     | Compile to `dist/` (what the Docker image runs)                              |

To run the app on the host against the Docker infrastructure:

```bash
docker compose up -d postgres kafka kafka-init dev-idp
docker compose stop app   # if the full stack is running, free port 3410
cp .env.example .env && set -a && . ./.env && set +a
npm run start:dev
```
