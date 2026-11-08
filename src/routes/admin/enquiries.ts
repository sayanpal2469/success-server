import { Router } from 'express';
import { z } from 'zod';

import { notFound } from '../../lib/errors.js';
import { parse, zId, zText } from '../../lib/validate.js';
import { Course } from '../../models/content.js';
import { Enquiry, ENQUIRY_STATUSES, type EnquiryDoc } from '../../models/enquiries.js';

/** Enquiry and free-demo forms sent from the website. */
export const enquiriesRouter = Router();

async function view(rows: EnquiryDoc[]) {
  const ids = [...new Set(rows.flatMap((e) => (e.course ? [String(e.course)] : [])))];
  const titles = new Map((await Course.find({ _id: { $in: ids } }, { title: 1 }).lean()).map((c) => [String(c._id), c.title]));
  return rows.map((e) => ({
    id: String(e._id),
    kind: e.kind,
    name: e.name,
    phone: e.phone,
    classId: e.classId ?? undefined,
    subjectIds: e.subjectIds,
    extras: e.extras,
    courseId: e.course ? String(e.course) : undefined,
    // Kept even if the course is deleted later.
    courseTitle: e.course ? (titles.get(String(e.course)) ?? 'Deleted course') : undefined,
    slot: e.slot ?? undefined,
    message: e.message,
    utm: e.utm ? Object.fromEntries(e.utm instanceof Map ? e.utm : Object.entries(e.utm)) : undefined,
    status: e.status,
    note: e.note,
    contactedAt: e.contactedAt ?? undefined,
    createdAt: (e as unknown as { createdAt: Date }).createdAt,
  }));
}

enquiriesRouter.get('/enquiries', async (req, res) => {
  const q = parse(z.object({ status: z.enum([...ENQUIRY_STATUSES, 'ALL']).default('ALL'), limit: z.coerce.number().int().min(1).max(2000).default(1000) }), req.query);
  const rows = await Enquiry.find(q.status === 'ALL' ? {} : { status: q.status }).sort({ createdAt: -1 }).limit(q.limit).lean();
  res.json(await view(rows as EnquiryDoc[]));
});

enquiriesRouter.patch('/enquiries/:id', async (req, res) => {
  const body = parse(z.object({ status: z.enum(ENQUIRY_STATUSES).optional(), note: zText(1000).optional() }), req.body);
  const e = await Enquiry.findById(parse(zId, req.params.id));
  if (!e) throw notFound('Enquiry');
  if (body.status && body.status !== e.status) {
    if (body.status !== 'NEW' && !e.contactedAt) e.contactedAt = new Date();
    if (body.status === 'NEW') e.contactedAt = undefined;
    e.status = body.status;
  }
  if (body.note !== undefined) e.note = body.note;
  await e.save();
  res.json((await view([e.toObject() as EnquiryDoc]))[0]);
});

enquiriesRouter.delete('/enquiries/:id', async (req, res) => {
  const r = await Enquiry.deleteOne({ _id: parse(zId, req.params.id) });
  if (!r.deletedCount) throw notFound('Enquiry');
  res.status(204).end();
});
