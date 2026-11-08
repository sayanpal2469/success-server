import { Router } from 'express';
import mongoose, { type Types } from 'mongoose';
import { z } from 'zod';

import { adminOf, hashPassword, revokeAllFor, tempPassword } from '../../lib/auth.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { signDocuments } from '../../lib/files.js';
import { zAdmission } from '../../lib/schemas.js';
import { addMonthsInclusive, todayIST } from '../../lib/time.js';
import { parse, searchRegex, zCode, zDate, zId, zPage, zPassword, zPatch, zText } from '../../lib/validate.js';
import { Course } from '../../models/content.js';
import { getSettings } from '../../models/org.js';
import { Application, Feedback, Payment, PAY_METHODS, Student, type StudentDoc } from '../../models/students.js';
import { Exam } from '../../models/tests.js';
import { enrolmentDates, nextStudentId, recordPayment } from '../../services/admissions.js';
import { checkEnrolment, loadCatalog, subjectNames, type Catalog } from '../../services/catalog.js';
import { sendMail } from '../../lib/mail.js';
import { newPasswordEmail, welcomeEmail } from '../../mail/templates.js';
import { summariesFor } from '../../services/dues.js';
import { hardDeleteStudents, restoreStudents, softDeleteStudents, studentLinks } from '../../services/studentDelete.js';
import { feeOf, ledgerFor, summarise } from '../../services/fees.js';
import { performanceOf } from '../../services/performance.js';

export const studentsRouter = Router();

/* ───────────────────────── Shapes ───────────────────────── */

const zEnrolment = z.object({
  batch: zText(60).default(''),
  roll: zText(20).default(''),
  admissionDate: zDate.optional(),
  durationMonths: z.number().int().min(1).max(60).optional(),
  validTill: zDate.optional(),
  discount: z.number().min(0).max(100_000).default(0),
  discountReason: zText(200).optional(),
  courseIds: z.array(zId).max(50).default([]),
});

/** Optional first payment taken at the admission desk (defaults to the admission month). */
const zFirstPayment = z
  .object({
    months: z.array(z.string()).max(24).optional(),
    amount: z.number().min(0).max(10_000_000).optional(),
    method: z.enum(PAY_METHODS),
    reference: zText(80).optional(),
    note: zText(300).optional(),
  })
  .optional();

const admitBody = zAdmission.extend(zEnrolment.shape).extend({ password: zPassword.optional(), firstPayment: zFirstPayment });

export async function adminStudentView(s: StudentDoc & { toJSON?: () => Record<string, unknown> }, cat: Catalog) {
  const json = (s.toJSON ? s.toJSON() : { ...s, id: String(s._id) }) as Record<string, unknown>;
  delete json._id;
  delete json.passwordHash;
  return {
    ...json,
    className: cat.classes.get(s.classId)?.name ?? s.classId,
    subjects: subjectNames(cat, s),
    documents: signDocuments(s.documents),
    fee: feeOf(s, cat),
  };
}

async function checkCourses(ids: string[]) {
  if (!ids.length) return [];
  const found = await Course.countDocuments({ _id: { $in: ids } });
  if (found !== new Set(ids).size) throw badRequest('Unknown course in courseIds', { field: 'courseIds' });
  return [...new Set(ids)].map((id) => new mongoose.Types.ObjectId(id));
}

/** Emails are the app login, so each belongs to one student (deleted ones included, until removed for good). */
async function emailFree(email: string, except?: Types.ObjectId) {
  const taken = await Student.exists({ email, ...(except ? { _id: { $ne: except } } : {}) }).setOptions({ withDeleted: true });
  if (taken) throw conflict('Another student already uses this email', { field: 'email' });
}

/** Welcome email with the login details (the password only when the office set it). Never throws. */
async function sendWelcome(s: StudentDoc, cat: Catalog, password?: string) {
  if (!s.email) return false;
  return sendMail(await welcomeEmail({ name: s.name, email: s.email, studentId: s.studentId, className: cat.classes.get(s.classId)?.name ?? s.classId, password }));
}

/**
 * Creates a student (office admission or an approved app request) and, optionally, records the first
 * payment — all in one transaction so a failed payment never leaves a half-made admission.
 */
async function admit(body: z.infer<typeof admitBody>, by: string, opts: { passwordHash?: string; application?: Types.ObjectId } = {}) {
  const cat = await loadCatalog();
  const { subjectIds, extras } = checkEnrolment(cat, body);
  const courseIds = await checkCourses(body.courseIds);
  const dates = await enrolmentDates(body);
  const plain = opts.passwordHash ? undefined : (body.password ?? tempPassword());
  const passwordHash = opts.passwordHash ?? (await hashPassword(plain!));
  const { password: _pw, firstPayment, ...data } = body;
  if (!data.email) throw badRequest('Add the student’s email — they sign in to the app with it', { field: 'email' });
  await emailFree(data.email);

  return mongoose.connection.transaction(async (session) => {
    const [student] = await Student.create(
      [
        {
          ...data,
          email: data.email || undefined,
          subjectIds,
          extras,
          courseIds,
          ...dates,
          idIssued: todayIST(),
          studentId: await nextStudentId(session),
          passwordHash,
          application: opts.application,
        },
      ],
      { session },
    );
    const payment = firstPayment
      ? await recordPayment(student!, cat, { ...firstPayment, months: firstPayment.months ?? [dates.admissionDate.slice(0, 7)] }, by, session)
      : undefined;
    if (opts.application) {
      const r = await Application.updateOne({ _id: opts.application, status: 'PENDING' }, { status: 'APPROVED', student: student!._id, reviewedAt: new Date() }, { session });
      if (!r.modifiedCount) throw conflict('This request was already reviewed');
    }
    return { student: student!, payment, tempPassword: plain && !body.password ? plain : undefined, cat };
  });
}

/* ───────────────────────── Students ───────────────────────── */

const listQuery = zPage.extend({
  q: z.string().max(80).optional(),
  classId: zCode.optional(),
  batch: z.string().max(60).optional(),
  extra: zCode.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
  fee: z.enum(['PAID', 'DUE', 'OVERDUE']).optional(),
  sort: z.enum(['name', 'studentId', 'admissionDate', '-admissionDate']).default('name'),
});

/** Student list with fee status — every class page, the search box and the pending-fees tab use it. */
studentsRouter.get('/students', async (req, res) => {
  const q = parse(listQuery, req.query);
  const filter: Record<string, unknown> = {};
  if (q.status !== 'ALL') filter.status = q.status;
  if (q.classId) filter.classId = q.classId;
  if (q.batch) filter.batch = q.batch;
  if (q.extra) filter.extras = q.extra;
  if (q.q) {
    const rx = searchRegex(q.q);
    const digits = q.q.replace(/\D/g, '');
    filter.$or = [{ name: rx }, { studentId: rx }, ...(digits.length >= 4 ? [{ phone: new RegExp(digits) }, { guardianPhone: new RegExp(digits) }] : [])];
  }
  const sort = q.sort.startsWith('-') ? { [q.sort.slice(1)]: -1 as const } : { [q.sort]: 1 as const };
  const [cat, settings, all] = await Promise.all([loadCatalog(), getSettings(), Student.find(filter).sort(sort).lean()]);
  const dues = await summariesFor(all, cat, settings.dueDay, todayIST());
  let rows = all.map((s) => {
    const summary = dues.get(String(s._id))!;
    return {
      id: String(s._id),
      studentId: s.studentId,
      name: s.name,
      photo: s.photo,
      classId: s.classId,
      className: cat.classes.get(s.classId)?.name ?? s.classId,
      batch: s.batch,
      phone: s.phone,
      guardianPhone: s.guardianPhone,
      extras: s.extras,
      subjectIds: s.subjectIds,
      admissionDate: s.admissionDate,
      validTill: s.validTill,
      status: s.status,
      fees: summary,
    };
  });
  if (q.fee) rows = rows.filter((r) => r.fees.status === q.fee);
  const total = rows.length;
  res.json({ data: rows.slice((q.page - 1) * q.limit, q.page * q.limit), meta: { page: q.page, limit: q.limit, total } });
});

/** Office admission. Without a password a temporary one is generated and returned once (to SMS / hand over). */
studentsRouter.post('/students', async (req, res) => {
  const body = parse(admitBody, req.body);
  const r = await admit(body, adminOf(req).name);
  // The password goes to the student by email; it is also returned once in case the email fails.
  const emailed = await sendWelcome(r.student, r.cat, r.tempPassword ?? body.password);
  res.status(201).json({ student: await adminStudentView(r.student, r.cat), payment: r.payment, tempPassword: r.tempPassword, emailed });
});

async function findStudent(id: unknown) {
  const s = await Student.findById(parse(zId, id));
  if (!s) throw notFound('Student');
  return s;
}

/* ───────────────────────── Delete, deleted list, restore ───────────────────────── */

const zIds = z.object({ ids: z.array(zId).min(1).max(1000) });

/** Where each student is used, shown in the delete pop-up before choosing soft or hard delete. */
studentsRouter.post('/students/delete-check', async (req, res) => {
  res.json(await studentLinks(parse(zIds, req.body).ids));
});

/** SOFT hides the students (restorable); HARD removes them and everything about them for good. */
studentsRouter.post('/students/delete', async (req, res) => {
  const { ids, mode } = parse(zIds.extend({ mode: z.enum(['SOFT', 'HARD']) }), req.body);
  const n = mode === 'SOFT' ? await softDeleteStudents(ids, adminOf(req).name) : await hardDeleteStudents(ids);
  res.json({ mode, count: n });
});

/** Soft-deleted students, newest first. */
studentsRouter.get('/students/deleted', async (_req, res) => {
  const [rows, cat] = await Promise.all([Student.find({ deletedAt: { $ne: null } }).sort({ deletedAt: -1 }), loadCatalog()]);
  res.json(await Promise.all(rows.map(async (s) => ({ ...(await adminStudentView(s, cat)), deletedAt: s.deletedAt, deletedBy: s.deletedBy ?? '' }))));
});

studentsRouter.post('/students/restore', async (req, res) => {
  res.json({ count: await restoreStudents(parse(zIds, req.body).ids) });
});

studentsRouter.get('/students/:id', async (req, res) => {
  const s = await findStudent(req.params.id);
  const [cat, settings, payments, app] = await Promise.all([
    loadCatalog(),
    getSettings(),
    Payment.find({ student: s._id, active: true }).sort({ receivedAt: -1 }),
    s.application ? Application.findById(s.application, { ref: 1, createdAt: 1 }).lean() : null,
  ]);
  const fee = feeOf(s, cat);
  const ledger = ledgerFor(s, cat, payments, settings.dueDay, todayIST());
  res.json({
    ...(await adminStudentView(s, cat)),
    application: app ? { id: String(app._id), ref: app.ref, submittedAt: app.createdAt } : undefined,
    fees: { breakdown: fee, summary: summarise(ledger, fee.monthly), months: ledger, payments },
  });
});

const updateBody = zPatch(zAdmission.extend(zEnrolment.shape))
  .extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional(), idIssued: zDate.optional() })
  .strict();

studentsRouter.patch('/students/:id', async (req, res) => {
  const s = await findStudent(req.params.id);
  const body = parse(updateBody, req.body);
  const cat = await loadCatalog();
  const next = { classId: body.classId ?? s.classId, subjectIds: body.subjectIds ?? s.subjectIds, extras: body.extras ?? s.extras, batch: body.batch ?? s.batch };
  if (body.classId && body.classId !== s.classId && !body.subjectIds) throw badRequest('Pick the subjects for the new class', { field: 'subjectIds' });
  if (body.classId && body.classId !== s.classId && body.batch === undefined) next.batch = '';
  const checked = checkEnrolment(cat, next);
  if (body.email && body.email !== s.email) await emailFree(body.email, s._id);
  const { courseIds, documents, ...rest } = body;
  Object.assign(s, rest, { subjectIds: checked.subjectIds, extras: checked.extras, batch: next.batch });
  if (body.email === '') s.email = undefined;
  if (documents) s.documents = { ...(s.documents ?? {}), ...documents };
  if (courseIds) s.courseIds = await checkCourses(courseIds);
  if ((body.admissionDate || body.durationMonths) && !body.validTill) s.validTill = addMonthsInclusive(s.admissionDate, s.durationMonths);
  if (s.validTill < s.admissionDate) throw badRequest('Valid till must be after the admission date', { field: 'validTill' });
  await s.save();
  if (body.status === 'INACTIVE') await revokeAllFor(s._id);
  res.json(await adminStudentView(s, cat));
});

/** Extends validity and reissues the ID card. */
studentsRouter.post('/students/:id/renew', async (req, res) => {
  const s = await findStudent(req.params.id);
  const body = parse(z.object({ durationMonths: z.number().int().min(1).max(60), from: zDate.optional() }), req.body);
  const from = body.from ?? (s.validTill >= todayIST() ? s.validTill : todayIST());
  s.validTill = addMonthsInclusive(from, body.durationMonths);
  s.durationMonths = s.durationMonths + body.durationMonths;
  s.idIssued = todayIST();
  s.status = 'ACTIVE';
  await s.save();
  res.json(await adminStudentView(s, await loadCatalog()));
});

studentsRouter.post('/students/:id/status', async (req, res) => {
  const s = await findStudent(req.params.id);
  const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) }), req.body);
  s.status = status;
  await s.save();
  if (status === 'INACTIVE') await revokeAllFor(s._id);
  res.json(await adminStudentView(s, await loadCatalog()));
});

/** New app password (typed or generated) — signs the student out everywhere. */
studentsRouter.post('/students/:id/reset-password', async (req, res) => {
  const s = await findStudent(req.params.id);
  const body = parse(z.object({ password: zPassword.optional() }), req.body ?? {});
  const plain = body.password ?? tempPassword();
  s.passwordHash = await hashPassword(plain);
  s.passwordChangedAt = new Date();
  await s.save();
  await revokeAllFor(s._id);
  const emailed = s.email ? await sendMail(await newPasswordEmail({ name: s.name, email: s.email, studentId: s.studentId, password: plain })) : false;
  res.json({ studentId: s.studentId, password: plain, emailed, email: s.email ?? '' });
});

studentsRouter.get('/students/:id/performance', async (req, res) => {
  const s = await findStudent(req.params.id);
  const q = parse(z.object({ from: zDate.optional(), to: zDate.optional() }), req.query);
  res.json(await performanceOf(s, await loadCatalog(), q));
});

/* ───────────────────────── Teacher feedback ───────────────────────── */

studentsRouter.post('/students/:id/feedback', async (req, res) => {
  const s = await findStudent(req.params.id);
  const body = parse(z.object({ text: z.string().trim().min(1).max(2000), examId: zId.optional() }), req.body);
  if (body.examId && !(await Exam.exists({ _id: body.examId }))) throw badRequest('Unknown exam', { field: 'examId' });
  const f = await Feedback.create({ student: s._id, exam: body.examId, text: body.text, by: adminOf(req).name });
  res.status(201).json(f);
});

studentsRouter.delete('/feedback/:id', async (req, res) => {
  const r = await Feedback.deleteOne({ _id: parse(zId, req.params.id) });
  if (!r.deletedCount) throw notFound('Feedback');
  res.status(204).end();
});

/** ID cards for a class, a batch or picked students (the panel prints / saves them as PDF). */
studentsRouter.get('/id-cards', async (req, res) => {
  const q = parse(z.object({ classId: zCode.optional(), batch: z.string().max(60).optional(), ids: z.string().max(5000).optional() }), req.query);
  const filter: Record<string, unknown> = { status: 'ACTIVE' };
  if (q.ids) filter._id = { $in: q.ids.split(',').map((x) => parse(zId, x.trim())) };
  else if (q.classId) filter.classId = q.classId;
  else throw badRequest('Pick a class or students');
  if (q.batch) filter.batch = q.batch;
  const [students, cat, settings, courses] = await Promise.all([Student.find(filter).sort({ name: 1 }).lean(), loadCatalog(), getSettings(), Course.find({}, { title: 1, access: 1 }).lean()]);
  res.json({
    institute: { name: settings.instituteName, centerHead: settings.centerHead, signature: settings.signature, address: settings.contact?.address, phone: settings.contact?.phone },
    cards: students.map((s) => ({
      id: String(s._id),
      studentId: s.studentId,
      name: s.name,
      photo: s.photo,
      phone: s.phone,
      guardianName: s.fatherName || s.motherName,
      className: cat.classes.get(s.classId)?.name ?? s.classId,
      batch: s.batch,
      courses: courses
        .filter((c) => c.access?.classes?.includes(s.classId) || c.access?.extras?.some((e) => s.extras.includes(e)) || s.courseIds.map(String).includes(String(c._id)))
        .map((c) => c.title),
      durationMonths: s.durationMonths,
      admissionDate: s.admissionDate,
      validTill: s.validTill,
      idIssued: s.idIssued,
      qr: `ST:${s.studentId}`,
    })),
  });
});

/* ───────────────────────── Admission requests ───────────────────────── */

studentsRouter.get('/applications', async (req, res) => {
  const q = parse(zPage.extend({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).default('PENDING'), q: z.string().max(80).optional() }), req.query);
  const filter: Record<string, unknown> = q.status === 'ALL' ? {} : { status: q.status };
  if (q.q) filter.$or = [{ name: searchRegex(q.q) }, { ref: searchRegex(q.q) }, { phone: searchRegex(q.q.replace(/\s/g, '')) }];
  const [rows, total, cat, counts] = await Promise.all([
    Application.find(filter)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
    Application.countDocuments(filter),
    loadCatalog(),
    Application.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  res.json({
    data: rows.map((a) => ({ ...a.toJSON(), className: cat.classes.get(a.classId)?.name ?? a.classId, documents: signDocuments(a.documents), fee: feeOf(a, cat) })),
    meta: { page: q.page, limit: q.limit, total, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) },
  });
});

async function findApplication(id: unknown) {
  const a = await Application.findById(parse(zId, id)).select('+passwordHash');
  if (!a) throw notFound('Admission request');
  return a;
}

studentsRouter.get('/applications/:id', async (req, res) => {
  const a = await findApplication(req.params.id);
  const cat = await loadCatalog();
  const json = a.toJSON() as Record<string, unknown>;
  delete json.passwordHash;
  res.json({ ...json, className: cat.classes.get(a.classId)?.name ?? a.classId, documents: signDocuments(a.documents), fee: feeOf(a, cat) });
});

/**
 * "Review & admit": the panel sends the (possibly corrected) admission form. Creates the student
 * with the password the applicant chose, issues the ID card and unlocks the app.
 */
studentsRouter.post('/applications/:id/approve', async (req, res) => {
  const a = await findApplication(req.params.id);
  if (a.status !== 'PENDING') throw conflict('This request was already reviewed');
  const base = a.toObject() as Record<string, unknown>;
  const body = parse(admitBody.omit({ password: true }), { ...pickAdmission(base), ...(req.body ?? {}) });
  const r = await admit(body, adminOf(req).name, { passwordHash: a.passwordHash, application: a._id });
  // They chose their password in the admission form, so the email doesn't carry one.
  const emailed = await sendWelcome(r.student, r.cat);
  res.status(201).json({ student: await adminStudentView(r.student, r.cat), payment: r.payment, emailed });
});

studentsRouter.post('/applications/:id/reject', async (req, res) => {
  const a = await findApplication(req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Give a reason — the applicant sees it').max(500) }), req.body);
  if (a.status !== 'PENDING') throw conflict('This request was already reviewed');
  a.status = 'REJECTED';
  a.rejectReason = reason;
  a.reviewedAt = new Date();
  await a.save();
  res.json({ id: String(a._id), status: a.status, rejectReason: a.rejectReason });
});

/** Admission fields of a stored request, in the shape the form schema expects. */
function pickAdmission(a: Record<string, unknown>) {
  const keys = Object.keys(zAdmission.shape);
  const out = Object.fromEntries(keys.filter((k) => a[k] !== undefined && a[k] !== null).map((k) => [k, a[k]]));
  if (out.documents) out.documents = Object.fromEntries(Object.entries(out.documents as object).filter(([, v]) => v));
  return out;
}
