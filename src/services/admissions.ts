import mongoose, { type ClientSession, type HydratedDocument, type Types } from 'mongoose';

import { badRequest, conflict } from '../lib/errors.js';
import { addMonthsInclusive, financialYear, istInstant, MONTH_RE, todayIST } from '../lib/time.js';
import { Counter, getSettings, nextSeq } from '../models/org.js';
import { Payment, Student, PAY_METHODS, type PaymentDoc, type StudentDoc } from '../models/students.js';
import type { Catalog } from './catalog.js';
import { billableMonths, monthAmount, paidFor } from './fees.js';

/* ───────────────────────── Numbers ───────────────────────── */

export async function nextStudentId(session?: ClientSession) {
  const { idPrefix } = await getSettings();
  // Start after the highest existing number with this prefix, so imported / seeded IDs never repeat.
  const last = await Student.findOne({ studentId: new RegExp(`^${idPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+$`) }, { studentId: 1 })
    .sort({ studentId: -1 })
    // Deleted students keep their ID, so it is never handed out again.
    .setOptions({ withDeleted: true })
    .session(session ?? null)
    .lean();
  const floor = last ? Number(last.studentId.slice(idPrefix.length)) : 100;
  const n = await nextSeq(`studentId:${idPrefix}`, floor, session);
  return `${idPrefix}${String(n).padStart(4, '0')}`.toUpperCase();
}

export async function nextReceiptNo(date: string, session?: ClientSession) {
  const fy = financialYear(date);
  const n = await nextSeq(`receipt:${fy}`, 0, session);
  return `ST/${fy}/${String(n).padStart(5, '0')}`;
}

export async function nextApplicationRef(session?: ClientSession) {
  const yy = todayIST().slice(2, 4);
  const n = await nextSeq(`application:${yy}`, 0, session);
  return `REQ-${yy}-${String(n).padStart(4, '0')}`;
}

/* ───────────────────────── Payments ───────────────────────── */

export type PaymentInput = {
  months: string[];
  /** Total received; spread over the months in order when `allocations` isn't given. */
  amount?: number;
  /** Amount per month (partial payments). */
  allocations?: { month: string; amount: number }[];
  method: (typeof PAY_METHODS)[number];
  reference?: string;
  note?: string;
  /** Defaults to now; the office may back-date a payment it forgot to enter. */
  receivedOn?: string;
};

/**
 * Confirms money the teacher received by hand for some months, issuing a receipt. Months must be
 * inside the enrolment (advance payments up to `validTill` are fine) and not fully paid. A month
 * can take less than what is left (a partial payment) — it then stays due for the rest — but never more.
 */
export async function recordPayment(s: StudentDoc, cat: Catalog, input: PaymentInput, by: string, session?: ClientSession): Promise<HydratedDocument<PaymentDoc>> {
  // One payment per student at a time: every payment bumps the student's lock document inside the
  // transaction, so two at once conflict and the retry sees the first one (months can't be overpaid).
  if (!session) return mongoose.connection.transaction((tx) => recordPayment(s, cat, input, by, tx));
  await Counter.updateOne({ _id: `pay:${String(s._id)}` }, { $inc: { seq: 1 } }, { upsert: true, session });
  const months = [...new Set(input.allocations?.length ? input.allocations.map((a) => a.month) : input.months)].sort();
  if (!months.length) throw badRequest('Pick at least one month');
  if (months.some((m) => !MONTH_RE.test(m))) throw badRequest('Months must be YYYY-MM');
  const allowed = new Set(billableMonths(s, s.validTill));
  const outside = months.filter((m) => !allowed.has(m));
  if (outside.length) throw badRequest(`Outside the enrolment period: ${outside.join(', ')}`, { field: 'months' });
  const earlier = await Payment.find({ student: s._id, active: true, months: { $in: months } }, { months: 1, amount: 1, allocations: 1, receiptNo: 1 })
    .session(session ?? null)
    .lean();
  const balance = new Map(months.map((m) => [m, paidFor(earlier, m, monthAmount(s, cat, m)).balance]));
  const settled = months.filter((m) => !balance.get(m));
  if (settled.length) throw conflict(`Already paid: ${settled.join(', ')}`, { months: settled, receipts: earlier.map((p) => p.receiptNo) });

  let allocations: { month: string; amount: number }[];
  if (input.allocations?.length) {
    allocations = months.map((m) => ({ month: m, amount: Math.round(input.allocations!.filter((a) => a.month === m).reduce((x, a) => x + a.amount, 0)) }));
    const over = allocations.filter((a) => a.amount > balance.get(a.month)!);
    if (over.length) throw badRequest(`More than what is left for ${over.map((a) => `${a.month} (₹${balance.get(a.month)})`).join(', ')}`, { field: 'allocations' });
  } else {
    // Spread the amount over the months, oldest first; without an amount every month is paid in full.
    let left = input.amount ?? [...balance.values()].reduce((a, b) => a + b, 0);
    const total = [...balance.values()].reduce((a, b) => a + b, 0);
    if (left > total) throw badRequest(`More than what is left (₹${total})`, { field: 'amount' });
    allocations = months.map((m) => {
      const take = Math.min(balance.get(m)!, left);
      left -= take;
      return { month: m, amount: take };
    });
  }
  allocations = allocations.filter((a) => a.amount > 0);
  if (!allocations.length) throw badRequest('Enter the amount received', { field: 'amount' });
  const amount = allocations.reduce((a, x) => a + x.amount, 0);
  const partial = allocations.some((a) => a.amount < balance.get(a.month)!);
  const day = input.receivedOn ?? todayIST();
  const receivedAt = input.receivedOn && input.receivedOn !== todayIST() ? istInstant(day, '12:00') : new Date();
  try {
    const [p] = await Payment.create(
      [
        {
          receiptNo: await nextReceiptNo(day, session),
          student: s._id,
          months: allocations.map((a) => a.month),
          amount,
          allocations,
          partial,
          method: input.method,
          reference: input.reference || undefined,
          note: input.note || undefined,
          receivedAt,
          receivedBy: by,
        },
      ],
      { session },
    );
    return p!;
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw conflict('That receipt number was just used — try again');
    throw e;
  }
}

/* ───────────────────────── Enrolment ───────────────────────── */

export type Enrolment = {
  batch?: string;
  admissionDate?: string;
  durationMonths?: number;
  validTill?: string;
  discount?: number;
  discountReason?: string;
  courseIds?: Types.ObjectId[] | string[];
};

/** Dates for a new or renewed enrolment, using the settings' default duration. */
export async function enrolmentDates(e: Enrolment) {
  const admissionDate = e.admissionDate ?? todayIST();
  const durationMonths = e.durationMonths ?? (await getSettings()).defaultDurationMonths;
  const validTill = e.validTill ?? addMonthsInclusive(admissionDate, durationMonths);
  if (validTill < admissionDate) throw badRequest('Valid till must be after the admission date', { field: 'validTill' });
  return { admissionDate, durationMonths, validTill };
}
