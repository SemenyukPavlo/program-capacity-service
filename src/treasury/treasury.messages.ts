import { z } from 'zod';
import { isCurrency, CurrencyCode } from '../common/money/currency';

/**
 * Inbound treasury message contracts (schemaVersion 1). Every message carries:
 *  - eventId: globally unique, used for de-duplication;
 *  - seq: per-program, strictly increasing across ALL treasury message types, used to drop
 *    stale/out-of-order messages. Messages are keyed by programId so Kafka preserves order
 *    within a topic; seq also protects ordering *across* the two topics.
 */
const currency = z
  .string()
  .refine(isCurrency, { message: 'Unsupported currency' })
  .transform((c) => c as CurrencyCode);

const amount = z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,12})?$/, 'Expected a non-negative decimal string');

const programStatus = z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']);

const base = {
  eventId: z.string().min(1).max(200),
  schemaVersion: z.literal(1),
  programId: z.string().min(1).max(100),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  occurredAt: z.string().datetime({ offset: true }),
};

export const ProgramUpsertedSchema = z.object({
  ...base,
  type: z.literal('PROGRAM_UPSERTED'),
  currency,
  limit: amount,
  status: programStatus,
});

export const ReservationReleasedSchema = z.object({
  ...base,
  type: z.literal('RESERVATION_RELEASED'),
  invoiceId: z.string().min(1).max(100),
  /** Invoice-currency repayment; omitted = full repayment. */
  amount: amount.optional(),
  currency: currency.optional(),
});

export const ProgramSnapshotSchema = z
  .object({
    ...base,
    type: z.literal('PROGRAM_SNAPSHOT'),
    /** Point in time the treasury state was captured. */
    asOf: z.string().datetime({ offset: true }),
    currency,
    limit: amount,
    status: programStatus,
    /** Every reservation treasury considers open, outstanding amount in PROGRAM currency. */
    reservations: z.array(z.object({ invoiceId: z.string().min(1).max(100), outstandingAmount: amount })).max(200_000),
  })
  .refine((m) => new Set(m.reservations.map((r) => r.invoiceId)).size === m.reservations.length, {
    message: 'Duplicate invoiceId in snapshot',
    path: ['reservations'],
  });

export const TreasuryMessageSchema = z.union([ProgramUpsertedSchema, ReservationReleasedSchema, ProgramSnapshotSchema]);

export type ProgramUpserted = z.infer<typeof ProgramUpsertedSchema>;
export type ReservationReleased = z.infer<typeof ReservationReleasedSchema>;
export type ProgramSnapshot = z.infer<typeof ProgramSnapshotSchema>;
export type TreasuryMessage = z.infer<typeof TreasuryMessageSchema>;
