-- Program capacity & invoice reservations: initial schema.
-- Monetary columns are NUMERIC; scale is enforced in the application per ISO 4217 minor units.

CREATE TABLE programs (
    id                  TEXT PRIMARY KEY,
    currency            CHAR(3)        NOT NULL,
    limit_amount        NUMERIC(24, 6) NOT NULL CHECK (limit_amount >= 0),
    -- Sum of outstanding reservations, in program currency. Maintained transactionally.
    -- Intentionally NO "reserved_amount <= limit_amount" constraint: treasury may lower the
    -- limit below current utilisation, in which case availability goes negative.
    reserved_amount     NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
    status              TEXT           NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
    version             BIGINT         NOT NULL DEFAULT 0,
    -- Highest treasury sequence number applied for this program (incremental events and snapshots).
    last_treasury_seq   BIGINT,
    last_reconciled_at  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE TABLE reservations (
    id                          UUID PRIMARY KEY,
    -- Monotonic insertion order; used as a stable pagination cursor.
    seq                         BIGSERIAL      NOT NULL UNIQUE,
    program_id                  TEXT           NOT NULL REFERENCES programs (id),
    invoice_id                  TEXT           NOT NULL,
    status                      TEXT           NOT NULL
        CHECK (status IN ('RESERVED', 'PARTIALLY_RELEASED', 'RELEASED', 'CANCELLED')),

    -- Original invoice amount and the outstanding part, in invoice currency.
    invoice_currency            CHAR(3)        NOT NULL,
    invoice_amount              NUMERIC(24, 6) NOT NULL CHECK (invoice_amount > 0),
    outstanding_invoice_amount  NUMERIC(24, 6) NOT NULL CHECK (outstanding_invoice_amount >= 0),

    -- Amount reserved against the program, in program currency, converted once at reservation time.
    program_amount              NUMERIC(24, 6) NOT NULL CHECK (program_amount > 0),
    outstanding_program_amount  NUMERIC(24, 6) NOT NULL CHECK (outstanding_program_amount >= 0),

    fx_rate                     NUMERIC(24, 12) NOT NULL CHECK (fx_rate > 0),
    fx_rate_source              TEXT           NOT NULL,
    fx_rate_at                  TIMESTAMPTZ    NOT NULL,

    source                      TEXT           NOT NULL CHECK (source IN ('API', 'TREASURY', 'RECONCILIATION')),
    created_by                  TEXT           NOT NULL,
    created_at                  TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ    NOT NULL DEFAULT now(),
    -- Last change made by this service (API or incremental treasury event), NOT by reconciliation.
    -- Used as the reconciliation watermark: local changes newer than a snapshot's as_of are kept.
    last_local_change_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
    closed_at                   TIMESTAMPTZ,

    -- An invoice is financed at most once per program.
    CONSTRAINT reservations_program_invoice_uq UNIQUE (program_id, invoice_id)
);

CREATE INDEX reservations_program_open_idx
    ON reservations (program_id)
    WHERE status IN ('RESERVED', 'PARTIALLY_RELEASED');

CREATE INDEX reservations_program_seq_idx ON reservations (program_id, seq);

-- Append-only audit trail of every capacity movement.
CREATE TABLE ledger_entries (
    id               BIGSERIAL PRIMARY KEY,
    program_id       TEXT           NOT NULL REFERENCES programs (id),
    reservation_id   UUID REFERENCES reservations (id),
    type             TEXT           NOT NULL
        CHECK (type IN ('RESERVE', 'RELEASE', 'CANCEL', 'LIMIT_CHANGE', 'STATUS_CHANGE', 'RECON_ADJUSTMENT')),
    -- Change of reserved_amount (signed); zero for limit/status changes.
    reserved_delta   NUMERIC(24, 6) NOT NULL,
    limit_delta      NUMERIC(24, 6) NOT NULL DEFAULT 0,
    reserved_after   NUMERIC(24, 6) NOT NULL,
    limit_after      NUMERIC(24, 6) NOT NULL,
    actor            TEXT           NOT NULL,
    correlation_id   TEXT,
    details          JSONB,
    created_at       TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_program_idx ON ledger_entries (program_id, id);

CREATE FUNCTION ledger_entries_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update_delete
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

-- Kafka de-duplication (at-least-once delivery).
CREATE TABLE processed_messages (
    message_id    TEXT PRIMARY KEY,
    topic         TEXT        NOT NULL,
    partition     INT         NOT NULL,
    "offset"      TEXT        NOT NULL,
    outcome       TEXT        NOT NULL,
    processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HTTP Idempotency-Key store. Only successful responses are stored (see README).
CREATE TABLE idempotency_keys (
    client_id        TEXT        NOT NULL,
    idempotency_key  TEXT        NOT NULL,
    request_hash     TEXT        NOT NULL,
    response_status  INT,
    response_body    JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, idempotency_key)
);

CREATE TABLE reconciliation_runs (
    id                UUID PRIMARY KEY,
    program_id        TEXT           NOT NULL REFERENCES programs (id),
    message_id        TEXT           NOT NULL,
    seq               BIGINT         NOT NULL,
    as_of             TIMESTAMPTZ    NOT NULL,
    status            TEXT           NOT NULL CHECK (status IN ('APPLIED', 'REQUIRES_REVIEW')),
    limit_before      NUMERIC(24, 6) NOT NULL,
    limit_after       NUMERIC(24, 6) NOT NULL,
    reserved_before   NUMERIC(24, 6) NOT NULL,
    reserved_after    NUMERIC(24, 6) NOT NULL,
    discrepancies     JSONB          NOT NULL,
    created_at        TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX reconciliation_runs_program_idx ON reconciliation_runs (program_id, created_at DESC);

-- Transactional outbox for events this service publishes.
CREATE TABLE outbox (
    id            BIGSERIAL PRIMARY KEY,
    topic         TEXT        NOT NULL,
    message_key   TEXT        NOT NULL,
    payload       JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ
);

CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
