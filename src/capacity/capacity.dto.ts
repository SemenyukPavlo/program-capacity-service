import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Format checks only; currency-specific scale and positivity are domain rules (Money.parse).
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,17})(\.\d{1,12})?$/, 'Must be a non-negative decimal string, e.g. "1500.00"')
  .describe('Decimal amount as a string, never a JSON number');

const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, 'ISO 4217 code')
  .describe('ISO 4217 currency code');

export const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Allowed characters: letters, digits, . _ : -');

export class ReserveDto extends createZodDto(
  z
    .object({
      invoiceId: id.describe('Business identifier of the invoice; unique per program'),
      amount,
      currency,
    })
    .strict(),
) {}

export class ReleaseDto extends createZodDto(
  z
    .object({
      amount: amount.optional().describe('Repaid amount in invoice currency; omit for full repayment'),
      currency: currency.optional(),
    })
    .strict(),
) {}

const order = z.enum(['asc', 'desc']).default('asc').describe('asc = oldest first, desc = newest first');

export class ListReservationsQuery extends createZodDto(
  z
    .object({
      status: z.enum(['RESERVED', 'PARTIALLY_RELEASED', 'RELEASED', 'CANCELLED']).optional(),
      order: order,
      cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    })
    .strict(),
) {}

export class ListLedgerQuery extends createZodDto(
  z
    .object({
      order: order,
      cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page'),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    })
    .strict(),
) {}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
