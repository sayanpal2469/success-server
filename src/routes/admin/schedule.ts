import { Router } from 'express';
import { z } from 'zod';

import { adminOf } from '../../lib/auth.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { addDays, todayIST, weekday } from '../../lib/time.js';
import { parse, zCode, zDate, zId, zPatch, zText, zTime } from '../../lib/validate.js';
import { ClassDef, Extra } from '../../models/catalog.js';
import { Notice } from '../../models/content.js';
import { Attendance, CheckIn, RoutineChange, Slot } from '../../models/schedule.js';
import { Student } from '../../models/students.js';
import { Attempt, Exam } from '../../models/tests.js';
import { groupName, loadCatalog, subjectNames } from '../../services/catalog.js';
import { testIsFor } from '../../services/tests.js';
import { groupFilter, notifyStudents } from '../../services/notify.js';
import { signFileUrl } from '../../lib/files.js';
import { setMark } from '../../services/checkin.js';

export const scheduleRouter = Router();

async function checkGroup(groupId: string) {
  if (!(await ClassDef.exists({ _id: groupId })) && !(await Extra.exists({ _id: groupId }))) throw badRequest('Unknown class or extra curriculum', { field: 'groupId' });
}

/** Students on a group's register: the class (and batch) or the extra curriculum's enrolled students. */
async function roster(groupId: string, batch: string, date: string) {
  const isClass = !!(await ClassDef.exists({ _id: groupId }));
  const filter: Record<string, unknown> = { status: 'ACTIVE', admissionDate: { $lte: date }, ...(isClass ? { classId: groupId } : { extras: groupId }) };
  if (isClass && batch) filter.batch = batch;
  return Student.find(filter, { name: 1, studentId: 1, batch: 1, classId: 1, photo: 1, guardianPhone: 1 }).sort({ name: 1 }).lean();
}

/* ───────────────────────── Weekly routine ───────────────────────── */

const slotShape = z.object({
  groupId: zCode,
  batch: zText(60).default(''),
  day: z.number().int().min(0).max(6),
  start: zTime,
  end: zTime,
  subject: z.string().trim().min(1).max(80),
  teacher: zText(120).default(''),
  room: zText(60).default(''),
});
const slotBody = slotShape.refine((s) => s.end > s.start, { message: 'End time must be after start', path: ['end'] });

scheduleRouter.get('/routine', async (req, res) => {
  const q = parse(z.object({ groupId: zCode.optional() }), req.query);
  res.json(await Slot.find(q.groupId ? { groupId: q.groupId } : {}).sort({ day: 1, start: 1 }));
});

scheduleRouter.post('/routine', async (req, res) => {
  const body = parse(slotBody, req.body);
  await checkGroup(body.groupId);
  res.status(201).json(await Slot.create(body));
});

scheduleRouter.patch('/routine/:id', async (req, res) => {
  const s = await Slot.findById(parse(zId, req.params.id));
  if (!s) throw notFound('Class slot');
  const body = parse(zPatch(slotShape), req.body);
  if (body.groupId) await checkGroup(body.groupId);
  s.set(body);
  if (s.end <= s.start) throw badRequest('End time must be after start', { field: 'end' });
  await s.save();
  res.json(s);
});

scheduleRouter.delete('/routine/:id', async (req, res) => {
  const id = parse(zId, req.params.id);
  const r = await Slot.deleteOne({ _id: id });
  if (!r.deletedCount) throw notFound('Class slot');
  await RoutineChange.deleteMany({ slot: id, date: { $gte: todayIST() } });
  res.status(204).end();
});

/* ───────────────────────── Postponed & cancelled ───────────────────────── */

scheduleRouter.get('/routine/changes', async (req, res) => {
  const q = parse(z.object({ groupId: zCode.optional(), from: zDate.optional() }), req.query);
  const filter: Record<string, unknown> = { date: { $gte: q.from ?? addDays(todayIST(), -30) } };
  if (q.groupId) filter.groupId = q.groupId;
  res.json(await RoutineChange.find(filter).sort({ date: 1 }).populate('slot'));
});

const changeBody = z
  .object({
    slotId: zId,
    date: zDate,
    kind: z.enum(['POSTPONED', 'CANCELLED', 'EXTRA']),
    newDate: zDate.optional(),
    newStart: zTime.optional(),
    newEnd: zTime.optional(),
    reason: zText(500).default(''),
    notify: z.boolean().default(true),
  })
  .refine((c) => c.kind === 'CANCELLED' || (c.newDate && c.newStart), { message: 'Give the new date and time', path: ['newDate'] });

const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Postpone / cancel a class on a date → notice for its students. */
scheduleRouter.post('/routine/changes', async (req, res) => {
  const body = parse(changeBody, req.body);
  const slot = await Slot.findById(body.slotId);
  if (!slot) throw notFound('Class slot');
  if (body.kind !== 'EXTRA' && weekday(body.date) !== slot.day) throw badRequest('That date is not a day this class runs', { field: 'date' });
  if (await RoutineChange.exists({ slot: slot._id, date: body.date })) throw conflict('This class already has a change on that date');
  const cat = await loadCatalog();
  let notice;
  if (body.notify) {
    const what = `${slot.subject} (${groupName(cat, slot.groupId)}${slot.batch ? ` · ${slot.batch}` : ''})`;
    const title = body.kind === 'CANCELLED' ? `Class cancelled — ${what}` : body.kind === 'POSTPONED' ? `Class postponed — ${what}` : `Extra class — ${what}`;
    const when =
      body.kind === 'CANCELLED'
        ? `The ${slot.start} class on ${fmt(body.date)} is cancelled.`
        : `The class on ${fmt(body.date)} at ${slot.start} moves to ${fmt(body.newDate!)} at ${body.newStart}.`;
    notice = await Notice.create({
      title,
      body: [when, body.reason].filter(Boolean).join(' '),
      audience: 'Class',
      target: slot.groupId,
      kind: 'ROUTINE',
      by: adminOf(req).name,
      expires: [body.date, body.newDate].filter(Boolean).sort().pop(),
    });
  }
  const { slotId: _s, notify: _n, ...rest } = body;
  const change = await RoutineChange.create({ ...rest, slot: slot._id, groupId: slot.groupId, notice: notice?._id });
  if (notice) await notifyStudents(groupFilter(slot.groupId), { type: 'routine', title: notice.title, body: notice.body, href: '/routine' });
  res.status(201).json(change);
});

scheduleRouter.delete('/routine/changes/:id', async (req, res) => {
  const c = await RoutineChange.findById(parse(zId, req.params.id));
  if (!c) throw notFound('Routine change');
  if (c.notice) await Notice.deleteOne({ _id: c.notice });
  await c.deleteOne();
  res.status(204).end();
});

/* ───────────────────────── Attendance ───────────────────────── */

const registerQuery = z.object({ groupId: zCode, date: zDate, batch: z.string().max(60).default('') });

/** The register for a group and date: students (present by default), saved marks, that day's classes. */
scheduleRouter.get('/attendance/register', async (req, res) => {
  const q = parse(registerQuery, req.query);
  await checkGroup(q.groupId);
  const [students, reg, slots] = await Promise.all([
    roster(q.groupId, q.batch, q.date),
    Attendance.findOne({ groupId: q.groupId, date: q.date, batch: q.batch }),
    Slot.find({ groupId: q.groupId, day: weekday(q.date) }).sort({ start: 1 }),
  ]);
  const marks = new Map((reg?.marks ?? []).map((m) => [String(m.student), m.mark]));
  const checkIns = new Map((await CheckIn.find({ groupId: q.groupId, date: q.date }, { student: 1, at: 1 }).lean()).map((c) => [String(c.student), c.at]));
  // A register started only by app check-ins: those who checked in are present, the rest not yet.
  const fallback = reg?.checkInOnly ? 'A' : 'P';
  res.json({
    groupId: q.groupId,
    date: q.date,
    batch: q.batch,
    taken: !!reg && !reg.checkInOnly,
    checkInOnly: !!reg?.checkInOnly,
    takenBy: reg?.takenBy,
    updatedAt: reg?.get('updatedAt'),
    slots,
    students: students.map((s) => ({ id: String(s._id), name: s.name, studentId: s.studentId, batch: s.batch, photo: s.photo, mark: marks.get(String(s._id)) ?? fallback, checkedInAt: checkIns.get(String(s._id)) })),
  });
});

/** Save the register: everyone on the roster is present unless listed in `absent`. */
scheduleRouter.put('/attendance/register', async (req, res) => {
  const body = parse(registerQuery.extend({ absent: z.array(zId).max(1000).default([]), alertGuardians: z.boolean().default(false) }), req.body);
  await checkGroup(body.groupId);
  if (body.date > todayIST()) throw badRequest('Attendance cannot be taken for a future date', { field: 'date' });
  const students = await roster(body.groupId, body.batch, body.date);
  const ids = new Set(students.map((s) => String(s._id)));
  const stray = body.absent.filter((id) => !ids.has(id));
  if (stray.length) throw badRequest('Some absent students are not on this register', { absent: stray });
  const absent = new Set(body.absent);
  const marks = students.map((s) => ({ student: s._id, mark: absent.has(String(s._id)) ? 'A' : 'P' }));
  const reg = await Attendance.findOneAndUpdate(
    { groupId: body.groupId, date: body.date, batch: body.batch },
    { $set: { marks, takenBy: adminOf(req).name, alertGuardians: body.alertGuardians, checkInOnly: false } },
    { upsert: true, returnDocument: 'after' },
  );
  // Guardian alerts need an SMS/WhatsApp provider; until one is set up the list is returned for the office to call.
  const alerts = body.alertGuardians ? students.filter((s) => absent.has(String(s._id))).map((s) => ({ name: s.name, guardianPhone: s.guardianPhone })) : [];
  res.json({ id: String(reg._id), present: marks.filter((m) => m.mark === 'P').length, absent: absent.size, alerts });
});

/** App check-ins on a date (selfie with GPS stamp), newest first. */
scheduleRouter.get('/attendance/check-ins', async (req, res) => {
  const q = parse(z.object({ date: zDate.optional() }), req.query);
  const date = q.date ?? todayIST();
  const rows = await CheckIn.find({ date }).sort({ at: -1 }).lean();
  const people = await Student.find({ _id: { $in: rows.map((r) => r.student) } }, { name: 1, studentId: 1, classId: 1, batch: 1, photo: 1, roll: 1 }).lean();
  const who = new Map(people.map((p) => [String(p._id), p]));
  const cat = await loadCatalog();
  // Soft-deleted students (not found here) are left out.
  res.json(
    rows.filter((r) => who.has(String(r.student))).map((r) => {
      const p = who.get(String(r.student));
      return {
        id: String(r._id),
        studentId: String(r.student),
        name: p?.name ?? 'Unknown',
        studentCode: p?.studentId,
        roll: p?.roll ?? '',
        className: groupName(cat, r.groupId),
        groupId: r.groupId,
        profilePhoto: p?.photo,
        at: r.at,
        source: r.source ?? 'APP',
        by: r.by,
        note: r.note ?? '',
        selfie: r.photo ? signFileUrl(r.photo, 240) : undefined,
        lat: r.lat,
        lng: r.lng,
        accuracy: r.accuracy,
        address: r.address,
        distance: r.distance,
        inside: r.inside,
      };
    }),
  );
});

const markBody = z.object({
  studentId: zId,
  date: zDate.optional(),
  present: z.boolean().default(true),
  /** Class or extra curriculum register; default the student's class. */
  groupId: zCode.optional(),
  note: zText(300).default(''),
});

/**
 * The office marks one student present (or absent) for a day — e.g. no phone, or the app check-in
 * failed. Present shows in the check-ins list as "marked by office".
 */
scheduleRouter.post('/attendance/mark', async (req, res) => {
  const body = parse(markBody, req.body);
  const date = body.date ?? todayIST();
  if (date > todayIST()) throw badRequest('Attendance cannot be marked for a future date', { field: 'date' });
  const s = await Student.findById(body.studentId, { classId: 1, extras: 1, status: 1, admissionDate: 1 }).lean();
  if (!s) throw notFound('Student');
  const groupId = body.groupId ?? s.classId;
  if (groupId !== s.classId && !s.extras.includes(groupId)) throw badRequest('The student is not in that class or extra curriculum', { field: 'groupId' });
  const who = adminOf(req).name;
  await setMark(groupId, date, s._id, body.present ? 'P' : 'A', who);
  const existing = await CheckIn.findOne({ student: s._id, date });
  if (body.present) {
    if (!existing) await CheckIn.create({ student: s._id, date, at: new Date(), groupId, source: 'OFFICE', by: who, note: body.note });
    else if (existing.source === 'OFFICE') {
      existing.note = body.note;
      await existing.save();
    }
  } else if (existing?.source === 'OFFICE') await existing.deleteOne();
  res.status(201).json({ studentId: String(s._id), date, groupId, mark: body.present ? 'P' : 'A' });
});

/** Undo a check-in (e.g. a wrong selfie): removes it and the present mark it made, if the office hasn't saved the register since. */
scheduleRouter.delete('/attendance/check-ins/:id', async (req, res) => {
  const r = await CheckIn.findById(parse(zId, req.params.id));
  if (!r) throw notFound('Check-in');
  await Attendance.updateOne({ groupId: r.groupId, date: r.date, batch: '', checkInOnly: true }, { $pull: { marks: { student: r.student } } });
  await r.deleteOne();
  res.status(204).end();
});

/** Registers taken on a date (dashboard and "today" view). */
scheduleRouter.get('/attendance/day', async (req, res) => {
  const q = parse(z.object({ date: zDate.optional() }), req.query);
  const date = q.date ?? todayIST();
  const regs = await Attendance.find({ date }).lean();
  res.json(regs.map((r) => ({ id: String(r._id), groupId: r.groupId, batch: r.batch, present: r.marks.filter((m) => m.mark === 'P').length, absent: r.marks.filter((m) => m.mark === 'A').length, takenBy: r.takenBy })));
});

/** Report: class attendance per student (below 75 % first) and exam attendance. */
scheduleRouter.get('/attendance/report', async (req, res) => {
  const q = parse(z.object({ groupId: zCode, batch: z.string().max(60).default(''), days: z.coerce.number().int().min(1).max(400).default(30), from: zDate.optional(), to: zDate.optional() }), req.query);
  await checkGroup(q.groupId);
  const to = q.to ?? todayIST();
  const from = q.from ?? addDays(to, -(q.days - 1));
  const cat = await loadCatalog();
  const students = await roster(q.groupId, q.batch, to);
  const regs = await Attendance.find({ groupId: q.groupId, date: { $gte: from, $lte: to }, ...(q.batch ? { batch: { $in: [q.batch, ''] } } : {}) }).lean();
  const isClass = cat.classes.has(q.groupId);
  const exams = isClass ? await Exam.find({ classId: q.groupId, date: { $gte: from, $lte: to }, endsAt: { $lt: new Date() } }, { questions: 0 }).lean() : [];
  const attempts = exams.length ? await Attempt.find({ kind: 'EXAM', test: { $in: exams.map((e) => e._id) } }, { test: 1, student: 1 }).lean() : [];
  const full = await Student.find({ _id: { $in: students.map((s) => s._id) } }, { classId: 1, subjectIds: 1 }).lean();
  const subj = new Map(full.map((s) => [String(s._id), subjectNames(cat, s)]));

  const rows = students.map((s) => {
    const id = String(s._id);
    const mine = regs.map((r) => r.marks.find((m) => String(m.student) === id)).filter((m) => !!m);
    const present = mine.filter((m) => m.mark === 'P').length;
    const due = exams.filter((e) => testIsFor(e, { classId: q.groupId }, subj.get(id) ?? []));
    const sat = due.filter((e) => attempts.some((a) => String(a.test) === String(e._id) && String(a.student) === id)).length;
    return {
      id,
      name: s.name,
      studentId: s.studentId,
      batch: s.batch,
      classes: { held: mine.length, present, percent: mine.length ? Math.round((present / mine.length) * 1000) / 10 : null },
      exams: { held: due.length, attended: sat, missed: due.length - sat },
    };
  });
  rows.sort((a, b) => (a.classes.percent ?? 101) - (b.classes.percent ?? 101) || a.name.localeCompare(b.name));
  res.json({ groupId: q.groupId, from, to, registers: regs.length, students: rows });
});
