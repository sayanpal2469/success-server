import { Router } from 'express';
import { z } from 'zod';

import { adminOf } from '../../lib/auth.js';
import { conflict, notFound } from '../../lib/errors.js';
import { istInstant, addDays } from '../../lib/time.js';
import { parse, zCode, zDate, zId, zMonth, zPage, zPhone, zText } from '../../lib/validate.js';
import { getSettings } from '../../models/org.js';
import { FeeReminder, Payment, PAY_METHODS, Student } from '../../models/students.js';
import { recordPayment } from '../../services/admissions.js';
import { loadCatalog } from '../../services/catalog.js';
import { notifyStudent } from '../../services/notify.js';

const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export const paymentsRouter = Router();

/** Payment history: newest first, filter by dates, method, class, student. */
paymentsRouter.get('/payments', async (req, res) => {
  const q = parse(
    zPage.extend({
      from: zDate.optional(),
      to: zDate.optional(),
      method: z.enum(PAY_METHODS).optional(),
      classId: zCode.optional(),
      studentId: zId.optional(),
      q: z.string().max(80).optional(),
      voided: z.enum(['true', 'false']).default('false'),
    }),
    req.query,
  );
  const filter: Record<string, unknown> = { active: q.voided !== 'true' };
  if (q.from || q.to) filter.receivedAt = { ...(q.from ? { $gte: istInstant(q.from) } : {}), ...(q.to ? { $lt: istInstant(addDays(q.to, 1)) } : {}) };
  if (q.method) filter.method = q.method;
  if (q.studentId) filter.student = q.studentId;
  if (q.classId || q.q) {
    const sf: Record<string, unknown> = {};
    if (q.classId) sf.classId = q.classId;
    if (q.q) {
      const rx = new RegExp(q.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      sf.$or = [{ name: rx }, { studentId: rx }];
    }
    const ids = await Student.find(sf, { _id: 1 }).lean();
    const or: Record<string, unknown>[] = [{ student: { $in: ids.map((s) => s._id) } }];
    if (q.q && !q.classId) or.push({ receiptNo: new RegExp(q.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
    filter.$or = or;
  }
  const [rows, total, sum] = await Promise.all([
    Payment.find(filter)
      .sort({ receivedAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate('student', 'name studentId classId batch photo'),
    Payment.countDocuments(filter),
    Payment.aggregate<{ total: number }>([{ $match: filter }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
  ]);
  res.json({ data: rows, meta: { page: q.page, limit: q.limit, total, amount: sum[0]?.total ?? 0 } });
});

const payBody = z.object({
  studentId: zId,
  months: z.array(zMonth).max(24).default([]),
  amount: z.number().min(0).max(10_000_000).optional(),
  /** Amount per month — less than the fee is a partial payment. */
  allocations: z.array(z.object({ month: zMonth, amount: z.number().int().min(0).max(10_000_000) })).max(24).optional(),
  method: z.enum(PAY_METHODS),
  reference: zText(80).optional(),
  note: zText(300).optional(),
  receivedOn: zDate.optional(),
});

/** "Receive payment" → "Confirm received": issues the receipt; the app shows those months as paid. */
paymentsRouter.post('/payments', async (req, res) => {
  const body = parse(payBody, req.body);
  const s = await Student.findById(body.studentId);
  if (!s) throw notFound('Student');
  const p = await recordPayment(s, await loadCatalog(), body, adminOf(req).name);
  await notifyStudent(s._id, { type: 'payment', title: `${p.partial ? 'Partial payment' : 'Payment'} received · ₹${p.amount.toLocaleString('en-IN')}`, body: `For ${p.months.map(monthName).join(', ')}. Receipt ${p.receiptNo}.${p.partial ? ' The rest is still due.' : ''}`, href: `/receipt/${String(p._id)}` });
  res.status(201).json(p);
});

/** Receipt view (print). */
paymentsRouter.get('/payments/:id', async (req, res) => {
  const p = await Payment.findById(parse(zId, req.params.id)).populate('student', 'name studentId classId batch phone');
  if (!p) throw notFound('Payment');
  const settings = await getSettings();
  res.json({ ...p.toJSON(), institute: { name: settings.instituteName, address: settings.contact?.address, phone: settings.contact?.phone, centerHead: settings.centerHead, signature: settings.signature } });
});

/** Removes an entry made by mistake. Kept as voided for the record; the months become unpaid again. */
paymentsRouter.delete('/payments/:id', async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Say why this entry is removed').max(300) }), req.body ?? {});
  const p = await Payment.findById(parse(zId, req.params.id));
  if (!p) throw notFound('Payment');
  if (!p.active) throw conflict('This payment was already removed');
  p.active = false;
  p.voidedAt = new Date();
  p.voidedBy = adminOf(req).name;
  p.voidReason = reason;
  await p.save();
  res.json(p);
});

/* ───────────────────────── WhatsApp fee reminders (log) ───────────────────────── */

/** Reminders of the last `days` days (default 120), newest first. */
paymentsRouter.get('/fee-reminders', async (req, res) => {
  const q = parse(z.object({ days: z.coerce.number().int().min(1).max(730).default(120) }), req.query);
  const rows = await FeeReminder.find({ at: { $gte: new Date(Date.now() - q.days * 86_400_000) } }).sort({ at: -1 }).limit(5000).lean();
  res.json(rows.map((r) => ({ id: String(r._id), studentId: String(r.student), months: r.months, amount: r.amount, phone: r.phone, by: r.by, at: r.at })));
});

/** Records a reminder the office just sent on WhatsApp. */
paymentsRouter.post('/fee-reminders', async (req, res) => {
  const body = parse(z.object({ studentId: zId, months: z.array(zMonth).max(60).default([]), amount: z.number().min(0).max(10_000_000).default(0), phone: zPhone }), req.body);
  if (!(await Student.exists({ _id: body.studentId }))) throw notFound('Student');
  const r = await FeeReminder.create({ student: body.studentId, months: body.months, amount: body.amount, phone: body.phone, by: adminOf(req).name });
  await notifyStudent(body.studentId, { type: 'fee', title: `Fee due${body.amount ? ` · ₹${body.amount.toLocaleString('en-IN')}` : ''}`, body: body.months.length ? `For ${body.months.map(monthName).join(', ')}. Please pay at the centre.` : 'Please pay your pending fee at the centre.', href: '/fees' });
  res.status(201).json({ id: String(r._id), studentId: body.studentId, months: r.months, amount: r.amount, phone: r.phone, by: r.by, at: r.at });
});
