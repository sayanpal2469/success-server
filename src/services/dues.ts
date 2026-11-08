import type { Types } from 'mongoose';

import { Payment, type StudentDoc } from '../models/students.js';
import type { Catalog } from './catalog.js';
import { feeOf, ledgerFor, summarise, type FeeSummary, type LedgerPayment } from './fees.js';

/** Fee summary for many students at once (one payments query). */
export async function summariesFor(students: StudentDoc[], cat: Catalog, dueDay: number, today: string) {
  const payments = await Payment.find({ student: { $in: students.map((s) => s._id) }, active: true }, { student: 1, months: 1, amount: 1, receiptNo: 1, method: 1, receivedAt: 1 }).lean();
  const by = new Map<string, LedgerPayment[]>();
  payments.forEach((p) => by.set(String(p.student), [...(by.get(String(p.student)) ?? []), p]));
  const out = new Map<string, FeeSummary>();
  for (const s of students) out.set(String(s._id as Types.ObjectId), summarise(ledgerFor(s, cat, by.get(String(s._id)) ?? [], dueDay, today), feeOf(s, cat).monthly));
  return out;
}
