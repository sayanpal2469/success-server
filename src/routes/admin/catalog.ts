import { Router } from 'express';
import { z } from 'zod';

import { adminOf, checkPassword, hashPassword, revokeAllFor } from '../../lib/auth.js';
import { badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';
import { parse, zCode, zEmail, zId, zName, zPassword, zPatch, zText, zUrl } from '../../lib/validate.js';
import { ClassDef, Extra } from '../../models/catalog.js';
import { Admin, getSettings, Settings } from '../../models/org.js';
import { Student } from '../../models/students.js';
import { Exam, MockTest } from '../../models/tests.js';
import { Slot } from '../../models/schedule.js';

export const catalogRouter = Router();

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/* ───────────────────────── Classes & subjects ───────────────────────── */

const zSubject = z.object({ id: zCode.optional(), name: zName, monthlyFee: z.number().min(0).max(1_000_000) });
const classBody = z.object({
  id: zCode,
  name: zName,
  group: z.enum(['School', 'College']),
  subjects: z.array(zSubject).max(40).default([]),
  batches: z.array(zText(60).min(1)).max(20).default([]),
  admissionFee: z.number().min(0).max(1_000_000).default(0),
  active: z.boolean().default(true),
  order: z.number().int().default(0),
});

function normaliseSubjects(classId: string, subjects: z.infer<typeof zSubject>[]) {
  const out = subjects.map((s) => ({ _id: s.id ?? `${classId}-${slug(s.name)}`, name: s.name, monthlyFee: s.monthlyFee }));
  const ids = out.map((s) => s._id);
  if (new Set(ids).size !== ids.length) throw badRequest('Two subjects have the same name or id', { field: 'subjects' });
  return out;
}

/** Classes with student counts (and per-subject counts for the Subjects page). */
catalogRouter.get('/classes', async (_req, res) => {
  const [classes, counts, subjectCounts] = await Promise.all([
    ClassDef.find().sort({ order: 1 }),
    Student.aggregate<{ _id: string; n: number }>([{ $match: { status: 'ACTIVE' } }, { $group: { _id: '$classId', n: { $sum: 1 } } }]),
    Student.aggregate<{ _id: string; n: number }>([{ $match: { status: 'ACTIVE' } }, { $unwind: '$subjectIds' }, { $group: { _id: '$subjectIds', n: { $sum: 1 } } }]),
  ]);
  const n = new Map(counts.map((c) => [c._id, c.n]));
  const sn = new Map(subjectCounts.map((c) => [c._id, c.n]));
  res.json(
    classes.map((c) => {
      const j = c.toJSON() as unknown as Record<string, unknown> & { subjects: { id: string }[] };
      return { ...j, students: n.get(c._id) ?? 0, subjects: j.subjects.map((s) => ({ ...s, students: sn.get(s.id) ?? 0 })) };
    }),
  );
});

catalogRouter.post('/classes', async (req, res) => {
  const body = parse(classBody, req.body);
  if (await ClassDef.exists({ _id: body.id })) throw conflict(`A class with id "${body.id}" already exists`);
  if (await Extra.exists({ _id: body.id })) throw conflict(`"${body.id}" is already used by an extra curriculum`);
  const { id, subjects, ...rest } = body;
  const c = await ClassDef.create({ _id: id, ...rest, subjects: normaliseSubjects(id, subjects) });
  res.status(201).json(c);
});

/** Edit a class. `subjects` replaces the list; a subject still taken by active students can't be removed. */
catalogRouter.patch('/classes/:id', async (req, res) => {
  const c = await ClassDef.findById(parse(zCode, req.params.id));
  if (!c) throw notFound('Class');
  const body = parse(zPatch(classBody.omit({ id: true })), req.body);
  const { subjects, ...rest } = body;
  if (subjects) {
    const next = normaliseSubjects(c._id, subjects);
    const removed = c.subjects.map((s) => s._id).filter((id) => !next.some((n) => n._id === id));
    if (removed.length) {
      const inUse = await Student.countDocuments({ status: 'ACTIVE', subjectIds: { $in: removed } });
      if (inUse) throw conflict(`${inUse} active student(s) take a subject you removed — change their subjects first`, { subjectIds: removed });
    }
    c.set('subjects', next);
  }
  if (rest.batches) {
    const gone = c.batches.filter((b) => !rest.batches!.includes(b));
    if (gone.length && (await Student.exists({ classId: c._id, status: 'ACTIVE', batch: { $in: gone } }))) throw conflict(`Students are still in batch ${gone.join(', ')} — move them first`);
  }
  Object.assign(c, rest);
  await c.save();
  res.json(c);
});

catalogRouter.delete('/classes/:id', async (req, res) => {
  const id = parse(zCode, req.params.id);
  const [students, exams, mocks, slots] = await Promise.all([Student.countDocuments({ classId: id }), Exam.countDocuments({ classId: id }), MockTest.countDocuments({ classId: id }), Slot.countDocuments({ groupId: id })]);
  if (students + exams + mocks + slots) throw conflict('This class has students, tests or routine — close it for admission instead');
  const r = await ClassDef.deleteOne({ _id: id });
  if (!r.deletedCount) throw notFound('Class');
  res.status(204).end();
});

/* ───────────────────────── Extra curriculums ───────────────────────── */

const extraBody = z.object({
  id: zCode,
  name: zName,
  description: zText(1000).default(''),
  monthlyFee: z.number().min(0).max(1_000_000),
  teacher: zText(120).default(''),
  active: z.boolean().default(true),
  order: z.number().int().default(0),
});

catalogRouter.get('/extras', async (_req, res) => {
  const [extras, counts] = await Promise.all([
    Extra.find().sort({ order: 1 }),
    Student.aggregate<{ _id: string; n: number }>([{ $match: { status: 'ACTIVE' } }, { $unwind: '$extras' }, { $group: { _id: '$extras', n: { $sum: 1 } } }]),
  ]);
  const n = new Map(counts.map((c) => [c._id, c.n]));
  res.json(extras.map((e) => ({ ...e.toJSON(), students: n.get(e._id) ?? 0 })));
});

catalogRouter.post('/extras', async (req, res) => {
  const body = parse(extraBody, req.body);
  if ((await Extra.exists({ _id: body.id })) || (await ClassDef.exists({ _id: body.id }))) throw conflict(`The id "${body.id}" is already used`);
  const { id, ...rest } = body;
  res.status(201).json(await Extra.create({ _id: id, ...rest }));
});

catalogRouter.patch('/extras/:id', async (req, res) => {
  const e = await Extra.findById(parse(zCode, req.params.id));
  if (!e) throw notFound('Extra curriculum');
  Object.assign(e, parse(zPatch(extraBody.omit({ id: true })), req.body));
  await e.save();
  res.json(e);
});

catalogRouter.delete('/extras/:id', async (req, res) => {
  const id = parse(zCode, req.params.id);
  if (await Student.exists({ extras: id })) throw conflict('Students are enrolled — remove them or switch it off instead');
  const r = await Extra.deleteOne({ _id: id });
  if (!r.deletedCount) throw notFound('Extra curriculum');
  res.status(204).end();
});

/** Enrolled students of an extra curriculum. */
catalogRouter.get('/extras/:id/students', async (req, res) => {
  const id = parse(zCode, req.params.id);
  res.json(await Student.find({ extras: id, status: 'ACTIVE' }, { name: 1, studentId: 1, classId: 1, batch: 1, phone: 1, photo: 1 }).sort({ name: 1 }));
});

/** Add or remove students; their monthly fee changes from the next unpaid month. */
catalogRouter.post('/extras/:id/students', async (req, res) => {
  const id = parse(zCode, req.params.id);
  if (!(await Extra.exists({ _id: id }))) throw notFound('Extra curriculum');
  const body = parse(z.object({ add: z.array(zId).max(500).default([]), remove: z.array(zId).max(500).default([]) }), req.body);
  const [added, removed] = await Promise.all([
    body.add.length ? Student.updateMany({ _id: { $in: body.add } }, { $addToSet: { extras: id } }) : null,
    body.remove.length ? Student.updateMany({ _id: { $in: body.remove } }, { $pull: { extras: id } }) : null,
  ]);
  res.json({ added: added?.modifiedCount ?? 0, removed: removed?.modifiedCount ?? 0 });
});

/* ───────────────────────── Settings ───────────────────────── */

/** A UPI ID (VPA): name@bank, e.g. successtutorials@okaxis. */
const UPI_ID = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

const settingsBody = z
  .object({
    instituteName: zName,
    centerHead: zText(120),
    signature: z.union([zUrl, z.string().startsWith('data:image/').max(400_000)]),
    idPrefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{1,10}$/, 'Letters, numbers and dashes, up to 10'),
    defaultDurationMonths: z.number().int().min(1).max(60),
    admissionOpen: z.boolean(),
    dueDay: z.number().int().min(1).max(28),
    reminderTemplate: z.string().trim().min(10).max(1000),
    admissionRules: z.array(z.string().trim().min(1).max(500)).max(20),
    checkIn: z.object({
      enabled: z.boolean(),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),
      radius: z.number().int().min(20).max(5000),
    }),
    tagline: zText(200),
    upi: z.object({
      enabled: z.boolean(),
      id: z.union([z.literal(''), z.string().trim().regex(UPI_ID, 'Enter a UPI ID like name@okaxis')]),
      name: zText(80),
      qrImage: z.union([z.literal(''), zUrl]),
      note: zText(300),
    }),
  })
  .partial()
  .refine((b) => !b.upi?.enabled || !!b.upi.id, { message: 'Add the UPI ID before showing it in the app', path: ['upi', 'id'] });

catalogRouter.get('/settings', async (_req, res) => {
  res.json(await getSettings());
});

catalogRouter.patch('/settings', async (req, res) => {
  const body = parse(settingsBody, req.body);
  await getSettings();
  res.json(await Settings.findByIdAndUpdate('main', { $set: body }, { returnDocument: 'after', runValidators: true }));
});

/* ───────────────────────── Admin account ───────────────────────── */

catalogRouter.get('/me', (req, res) => {
  res.json(adminOf(req));
});

catalogRouter.patch('/me', async (req, res) => {
  const body = parse(z.object({ name: zName.optional(), email: zEmail }), req.body);
  const a = await Admin.findById(adminOf(req).id);
  if (!a) throw notFound('Admin');
  if (body.name) a.name = body.name;
  if (body.email) a.email = body.email;
  await a.save();
  res.json({ id: String(a._id), name: a.name, email: a.email });
});

/** Change password — signs out every other session of this admin. */
catalogRouter.put('/me/password', async (req, res) => {
  const body = parse(z.object({ current: z.string().max(200), next: zPassword.min(8, 'At least 8 characters') }), req.body);
  const a = await Admin.findById(adminOf(req).id).select('+passwordHash');
  if (!a || !(await checkPassword(body.current, a.passwordHash))) throw unauthorized('Current password is wrong');
  a.passwordHash = await hashPassword(body.next);
  await a.save();
  await revokeAllFor(a._id);
  res.status(204).end();
});
