# Event contracts

All messages are JSON, `schemaVersion: 1`, keyed by `programId`. Amounts are decimal strings
whose number of decimals must not exceed the currency's ISO 4217 minor units. Schemas live in
`src/treasury/treasury.messages.ts` (zod).

Common fields on every inbound message:

| Field           | Type         | Meaning                                                                |
| --------------- | ------------ | ---------------------------------------------------------------------- |
| `type`          | string       | Message type (below)                                                   |
| `schemaVersion` | `1`          | Contract version                                                       |
| `eventId`       | string ≤ 200 | Globally unique; used for de-duplication                               |
| `programId`     | string       | Partition key                                                          |
| `seq`           | integer      | Per-program, strictly increasing across **all** treasury message types |
| `occurredAt`    | ISO-8601     | When treasury produced it                                              |

## Inbound: `treasury.program-events`

### `PROGRAM_UPSERTED`

Creates a program or updates its terms.

```json
{
  "type": "PROGRAM_UPSERTED",
  "schemaVersion": 1,
  "eventId": "e-1",
  "programId": "PRG-USD-001",
  "seq": 42,
  "occurredAt": "2026-10-02T10:00:00Z",
  "currency": "USD",
  "limit": "10000000.00",
  "status": "ACTIVE"
}
```

`status`: `ACTIVE | SUSPENDED | CLOSED`. A currency change is rejected (sent to the DLQ) once the
program has reservations.

### `RESERVATION_RELEASED`

Treasury observed a repayment. `amount` and `currency` are in invoice currency; omit both for a
full repayment.

```json
{
  "type": "RESERVATION_RELEASED",
  "schemaVersion": 1,
  "eventId": "e-2",
  "programId": "PRG-USD-001",
  "seq": 43,
  "occurredAt": "2026-10-02T10:05:00Z",
  "invoiceId": "INV-1001",
  "amount": "40000.00",
  "currency": "EUR"
}
```

## Inbound: `treasury.reconciliation`

### `PROGRAM_SNAPSHOT`

Treasury's full state of a program at `asOf`. `reservations` lists **every** reservation
treasury considers open, with the outstanding amount in **program currency**. Topic
`max.message.bytes` is 10 MB; at most 200,000 reservations per message.

```json
{
  "type": "PROGRAM_SNAPSHOT",
  "schemaVersion": 1,
  "eventId": "e-3",
  "programId": "PRG-USD-001",
  "seq": 44,
  "occurredAt": "2026-10-02T11:00:00Z",
  "asOf": "2026-10-02T10:59:59Z",
  "currency": "USD",
  "limit": "9000000.00",
  "status": "ACTIVE",
  "reservations": [{ "invoiceId": "INV-1001", "outstandingAmount": "64800.00" }]
}
```

## Processing outcomes

`applied` · `duplicate` (eventId already processed) · `stale` (`seq` ≤ last applied) ·
`requires_review` (snapshot blocked by the drift guard) · dead-lettered.

## Dead letters: `treasury.dlq`

The original key and value are kept unchanged, with these headers added:
`x-original-topic`, `x-original-partition`, `x-original-offset`, `x-error`, `x-failed-at`.

## Outbound: `capacity.events`

Published through the transactional outbox after every committed capacity change.

```json
{
  "type": "CAPACITY_CHANGED",
  "eventId": "…",
  "programId": "PRG-USD-001",
  "version": 13,
  "currency": "USD",
  "limit": "9000000.00",
  "reserved": "50000.00",
  "available": "8950000.00",
  "status": "ACTIVE",
  "cause": "RESERVE | RELEASE | CANCEL | RECONCILIATION | PROGRAM_CREATED | PROGRAM_UPDATED",
  "occurredAt": "2026-10-02T11:00:00Z"
}
```

Delivery is at-least-once: de-duplicate by `eventId` and apply only when `version` is greater
than the last one seen for the program.
