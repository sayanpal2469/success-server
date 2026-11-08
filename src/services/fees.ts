import type { Types } from 'mongoose';

import { monthsBetween } from '../lib/time.js';
import type { Catalog } from './catalog.js';

/** What a student pays: chosen subjects + extra curriculums − discount, monthly. */
export type FeeBreakdown = { subjects: number; extras: number; discount: number; monthly: number; admissionFee: number };

type FeeInput = { classId: string; subjectIds: string[]; extras: string[]; discount?: number | null };

export function feeOf(s: FeeInput, cat: Catalog): FeeBreakdown {
  const cls = cat.classes.get(s.classId);
  const subjects = (cls?.subjects ?? []).filter((x) => s.subjectIds.includes(x._id)).reduce((a, x) => a + x.monthlyFee, 0);
  const extras = s.extras.reduce((a, id) => a + (cat.extras.get(id)?.monthlyFee ?? 0), 0);
  const discount = s.discount ?? 0;
  return { subjects, extras, discount, monthly: Math.max(0, subjects + extras - discount), admissionFee: cls?.admissionFee ?? 0 };
}

export type MonthStatus = 'PAID' | 'DUE' | 'OVERDUE';
export type Allocation = { month: string; amount: number };
export type LedgerPayment = { _id: Types.ObjectId; receiptNo: string; months: string[]; amount: number; method: string; receivedAt: Date; allocations?: Allocation[] | null; partial?: boolean | null };
/**
 * One billable month. `amount` is what the month shows: the amount paid when PAID, otherwise what is
 * still left to pay. `total` is the month's fee, `paid` what has come in so far (partial payments).
 */
export type LedgerMonth = { key: string; amount: number; total: number; paid: number; partial: boolean; due: string; status: MonthStatus; paymentId?: string; receiptNo?: string };

/** How much of a payment went to each month. Old payments (no allocations) paid their months in full. */
export function allocationsOf(p: Pick<LedgerPayment, 'months' | 'amount' | 'allocations'>): (Allocation & { full?: boolean })[] {
  if (p.allocations?.length) return p.allocations.map((a) => ({ month: a.month, amount: a.amount }));
  return p.months.map((month) => ({ month, amount: Math.round(p.amount / p.months.length), full: true }));
}

/** Paid so far for a month, and whether it is settled (fully paid, or paid in full before partial payments existed). */
export function paidFor(payments: Pick<LedgerPayment, 'months' | 'amount' | 'allocations'>[], key: string, total: number) {
  let paid = 0;
  let full = false;
  for (const p of payments) for (const a of allocationsOf(p)) if (a.month === key) (paid += a.amount), (full ||= !!a.full);
  return { paid, settled: full || paid >= total, balance: full ? 0 : Math.max(0, total - paid) };
}

type LedgerStudent = FeeInput & { admissionDate: string; validTill: string };

/** Amount owed for a month: the monthly fee, plus the admission fee in the first month. */
export function monthAmount(s: LedgerStudent, cat: Catalog, key: string) {
  const fee = feeOf(s, cat);
  return fee.monthly + (key === s.admissionDate.slice(0, 7) ? fee.admissionFee : 0);
}

/** Months a student is billed for: admission month → this month (never past validity). */
export function billableMonths(s: LedgerStudent, today: string) {
  const last = s.validTill < today ? s.validTill : today;
  return last < s.admissionDate ? [] : monthsBetween(s.admissionDate, last);
}

/** Every billable month with what has been paid (the admin's Fees tab and the app's Fees screen). */
export function ledgerFor(s: LedgerStudent, cat: Catalog, payments: LedgerPayment[], dueDay: number, today: string): LedgerMonth[] {
  return billableMonths(s, today).map((key) => {
    const mine = payments.filter((x) => x.months.includes(key)).sort((a, b) => +new Date(a.receivedAt) - +new Date(b.receivedAt));
    const last = mine.at(-1);
    const due = `${key}-${String(dueDay).padStart(2, '0')}`;
    const total = monthAmount(s, cat, key);
    const { paid, settled, balance } = paidFor(mine, key, total);
    const link = last ? { paymentId: String(last._id), receiptNo: last.receiptNo } : {};
    if (settled) return { key, amount: paid, total, paid, partial: false, due, status: 'PAID' as const, ...link };
    // Partly paid months stay due (overdue after the due date) for what is left.
    return { key, amount: balance, total, paid, partial: paid > 0, due, status: due < today ? ('OVERDUE' as const) : ('DUE' as const), ...link };
  });
}

export type FeeSummary = { paid: number; pending: number; overdueMonths: number; status: MonthStatus; monthly: number; nextDue?: string };

export function summarise(ledger: LedgerMonth[], monthly: number): FeeSummary {
  const sum = (st: MonthStatus[]) => ledger.filter((m) => st.includes(m.status)).reduce((a, m) => a + m.amount, 0);
  const overdueMonths = ledger.filter((m) => m.status === 'OVERDUE').length;
  const pending = sum(['DUE', 'OVERDUE']);
  return {
    // Includes the paid part of partly paid months.
    paid: ledger.reduce((a, m) => a + m.paid, 0),
    pending,
    overdueMonths,
    status: overdueMonths ? 'OVERDUE' : pending ? 'DUE' : 'PAID',
    monthly,
    nextDue: ledger.find((m) => m.status !== 'PAID')?.due,
  };
}
