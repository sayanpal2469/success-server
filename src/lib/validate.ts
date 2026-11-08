import { isValidObjectId } from 'mongoose';
import { z } from 'zod';

import { badRequest } from './errors.js';
import { DATE_RE, MONTH_RE, TIME_RE } from './time.js';

/** Parses request input; a failure becomes a 400 with one entry per bad field. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const fields = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw badRequest(fields[0] ? `${fields[0].path || 'input'}: ${fields[0].message}` : 'Invalid input', { fields });
}

/**
 * Partial version of an object schema for PATCH bodies: every field optional and **no defaults**
 * (Zod's `.partial()` still fills `.default()` values, which would reset fields the client didn't send).
 */
export function zPatch<S extends z.ZodObject>(schema: S): ReturnType<S['partial']> {
  const unwrap = (t: z.ZodType): z.ZodType => (t instanceof z.ZodDefault || t instanceof z.ZodPrefault ? unwrap(t.unwrap() as z.ZodType) : t);
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, unwrap(v as z.ZodType).optional()]));
  return z.object(shape) as unknown as ReturnType<S['partial']>;
}

export const zId = z.string().refine((v) => isValidObjectId(v) && /^[a-f\d]{24}$/i.test(v), 'Invalid id');
/** Human-readable codes used for classes, subjects and extra curriculums (`c10`, `c10-bengali`, `spoken`). */
export const zCode = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers and dashes');
export const zDate = z.string().regex(DATE_RE, 'Use YYYY-MM-DD');
export const zMonth = z.string().regex(MONTH_RE, 'Use YYYY-MM');
export const zTime = z.string().regex(TIME_RE, 'Use HH:mm');
export const zText = (max = 200) => z.string().trim().max(max);
export const zName = z.string().trim().min(1, 'Required').max(120);
export const zPhone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[^\d+]/g, ''))
  .pipe(z.string().regex(/^(\+91)?[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number'))
  .transform((v) => (v.startsWith('+91') ? v : `+91${v}`));
export const zOptPhone = z.union([z.literal(''), zPhone]).optional();
export const zEmail = z.union([z.literal(''), z.string().trim().toLowerCase().email().max(160)]).optional();
export const zAadhaar = z
  .string()
  .trim()
  .transform((v) => v.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{12}$/, 'Aadhaar must be 12 digits'));
export const zPassword = z.string().min(4, 'At least 4 characters').max(72);
/** A stored file (from POST /uploads) or an external https URL. */
export const zUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === '' || v.startsWith('/uploads/') || v.startsWith('/files/') || /^https:\/\//.test(v), 'Must be an uploaded file or an https link');

export const zPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const zQuestion = z.object({
  q: z.string().trim().min(1, 'Question text is required').max(2000),
  options: z.array(z.string().trim().min(1, 'Option is empty').max(500)).length(4, 'Exactly four options'),
  answer: z.number().int().min(0).max(3),
  explanation: zText(2000).optional(),
});

/** Escapes user text for a case-insensitive "contains" regex search. */
export const searchRegex = (q: string) => new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
