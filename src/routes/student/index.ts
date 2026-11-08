import { Router } from 'express';
import { z } from 'zod';

import { checkPassword, hashPassword, requireStudent, revokeAllFor, studentOf } from '../../lib/auth.js';
import { conflict, forbidden, notFound, unauthorized, unprocessable } from '../../lib/errors.js';
import { acceptUpload, uploader } from '../../lib/files.js';
import { uploadLimit } from '../../middleware/limits.js';
import { addDays, monthsBetween, todayIST, weekday } from '../../lib/time.js';
import { parse, zId, zMonth, zPassword, zText } from '../../lib/validate.js';
import { Banner, Course, FreeVideo, LessonProgress } from '../../models/content.js';
import { getSettings } from '../../models/org.js';
import { RoutineChange, Slot } from '../../models/schedule.js';
import { Payment, Student } from '../../models/students.js';
import { Exam, examStatus } from '../../models/tests.js';
import { groupName, loadCatalog, subjectNames } from '../../services/catalog.js';
import { accessFilter, hasAccess, lessonCount } from '../../services/courses.js';
import { feeOf, ledgerFor, summarise } from '../../services/fees.js';
import { appBannerFilter, appBannerView, noticesForStudent } from '../../services/notices.js';
import { attendanceOf, performanceOf } from '../../services/performance.js';
import { testIsFor } from '../../services/tests.js';
import { reportCards } from '../../services/reportCards.js';
import { studentProfile } from './serialize.js';
import { studentTestsRouter } from './tests.js';
import { Notification } from '../../models/notifications.js';
import { CheckIn } from '../../models/schedule.js';
import { groupToday, markPresent, distanceM } from '../../services/checkin.js';

export const studentRouter = Router();
studentRouter.use(requireStudent);

/* ───────────────────────── App check-in (selfie + GPS) ───────────────────────── */

/** The front-camera selfie (stamped with date, time and location in the app). Private file. */
studentRouter.post('/uploads/checkin', uploadLimit, uploader('image', 'private'), async (req, res) => {
  res.status(201).json(await acceptUpload(req, 'private'));
});

/** Can I check in today, and have I? */
studentRouter.get('/attendance/check-in', async (req, res) => {
  const s = studentOf(req);
  const settings = await getSettings();
  const today = todayIST();
  const [mine, { groupId, slots }] = await Promise.all([CheckIn.findOne({ student: s._id, date: today }).lean(), groupToday(s, today)]);
  const c = settings.checkIn;
  res.json({
    enabled: c?.enabled !== false,
    classToday: !!groupId,
    slots: slots.map((x) => ({ subject: x.subject, start: x.start, end: x.end })),
    centre: c?.lat !== undefined && c?.lat !== null && c?.lng !== undefined && c?.lng !== null ? { lat: c.lat, lng: c.lng, radius: c.radius ?? 200 } : null,
    checkedIn: mine ? { at: mine.at, address: mine.address, distance: mine.distance, inside: mine.inside } : null,
  });
});

const checkInBody = z.object({
  photo: z.string().regex(/^\/files\/[a-f0-9]{32}\.(jpg|png|webp)$/, 'Upload the selfie first'),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).default(0),
  address: zText(300).default(''),
  /** Android reports positions from "mock location" apps. */
  mocked: z.boolean().default(false),
});

/** Check in for today: marks the student present in today's register for their class. */
studentRouter.post('/attendance/check-in', async (req, res) => {
  const body = parse(checkInBody, req.body);
  const s = studentOf(req);
  const settings = await getSettings();
  const c = settings.checkIn;
  if (c?.enabled === false) throw unprocessable('CHECKIN_OFF', 'App check-in is turned off — the teacher takes attendance in class');
  if (body.mocked) throw unprocessable('MOCK_LOCATION', 'Turn off any fake-location app and try again');
  const today = todayIST();
  const { groupId } = await groupToday(s, today);
  if (!groupId) throw unprocessable('NO_CLASS', 'You have no class today');
  if (await CheckIn.exists({ student: s._id, date: today })) throw conflict('You have already checked in today');
  let distance: number | undefined;
  let inside: boolean | null = null;
  if (typeof c?.lat === 'number' && typeof c?.lng === 'number') {
    distance = distanceM({ lat: body.lat, lng: body.lng }, { lat: c.lat, lng: c.lng });
    const radius = c.radius ?? 200;
    // GPS can be off by its accuracy; allow that much (up to 100 m) on top of the radius.
    inside = distance - Math.min(body.accuracy, 100) <= radius;
    if (!inside) throw unprocessable('TOO_FAR', `You are about ${distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${distance} m`} from the centre — check in when you reach the centre`);
  }
  let row;
  try {
    row = await CheckIn.create({ student: s._id, date: today, at: new Date(), groupId, photo: body.photo, lat: body.lat, lng: body.lng, accuracy: body.accuracy, address: body.address, distance, inside });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw conflict('You have already checked in today');
    throw e;
  }
  await markPresent(groupId, today, s._id);
  res.status(201).json({ at: row.at, address: row.address, distance: row.distance, inside: row.inside });
});

/* ───────────────────────── Notifications (the bell) ───────────────────────── */

const noteView = (n: { _id: unknown; type: string; title: string; body?: string | null; href?: string | null; read: boolean; readAt?: Date | null; createdAt?: Date }) => ({
  id: String(n._id),
  type: n.type,
  title: n.title,
  body: n.body ?? '',
  href: n.href ?? '',
  read: n.read,
  readAt: n.readAt ?? undefined,
  at: n.createdAt,
});

/** Newest first, with the unread count for the badge. `before` (an ISO time) loads older ones. */
studentRouter.get('/notifications', async (req, res) => {
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(60), before: z.iso.datetime({ offset: true }).optional(), unread: z.enum(['1', 'true']).optional() }), req.query);
  const me = studentOf(req)._id;
  const filter: Record<string, unknown> = { student: me };
  if (q.before) filter.createdAt = { $lt: new Date(q.before) };
  if (q.unread) filter.read = false;
  const [rows, unread] = await Promise.all([Notification.find(filter).sort({ createdAt: -1 }).limit(q.limit).lean(), Notification.countDocuments({ student: me, read: false })]);
  res.json({ items: rows.map(noteView), unread });
});

/** Mark one read (or unread again). */
studentRouter.patch('/notifications/:id', async (req, res) => {
  const body = parse(z.object({ read: z.boolean() }), req.body);
  const n = await Notification.findOneAndUpdate({ _id: parse(zId, req.params.id), student: studentOf(req)._id }, { read: body.read, readAt: body.read ? new Date() : null }, { returnDocument: 'after' }).lean();
  if (!n) throw notFound('Notification');
  res.json(noteView(n));
});

studentRouter.post('/notifications/read-all', async (req, res) => {
  const r = await Notification.updateMany({ student: studentOf(req)._id, read: false }, { read: true, readAt: new Date() });
  res.json({ updated: r.modifiedCount, unread: 0 });
});

studentRouter.delete('/notifications/:id', async (req, res) => {
  const r = await Notification.deleteOne({ _id: parse(zId, req.params.id), student: studentOf(req)._id });
  if (!r.deletedCount) throw notFound('Notification');
  res.status(204).end();
});

/** Clear all (or only the read ones with `?read=1`). */
studentRouter.delete('/notifications', async (req, res) => {
  const q = parse(z.object({ read: z.enum(['1', 'true']).optional() }), req.query);
  const r = await Notification.deleteMany({ student: studentOf(req)._id, ...(q.read ? { read: true } : {}) });
  res.json({ deleted: r.deletedCount });
});

/* ───────────────────────── App home carousel ───────────────────────── */

/** Offers and ads for this student (everyone, all students, or their class). */
studentRouter.get('/banners', async (req, res) => {
  const rows = await Banner.find(appBannerFilter(studentOf(req))).sort({ order: 1, createdAt: 1 }).lean();
  res.json(rows.map(appBannerView));
});

/* ───────────────────────── Annual report card ───────────────────────── */

/** The student's own annual report card (published written exams of the session; mock tests not included). */
studentRouter.get('/report-card', async (req, res) => {
  const q = parse(z.object({ session: z.string().regex(/^\d{4}-\d{2}$/).optional() }), req.query);
  const r = await reportCards({ studentId: studentOf(req)._id, session: q.session });
  res.json({ session: r.session, institute: r.institute, card: r.cards[0] ?? null });
});

/* ───────────────────────── Written exam answer sheet upload ───────────────────────── */

/** Photos of the notebook as one PDF. Private: only the admin opens it (signed link). */
studentRouter.post('/uploads/answer', uploadLimit, uploader('answer', 'private'), async (req, res) => {
  res.status(201).json(await acceptUpload(req, 'private'));
});

/* ───────────────────────── Admission slip & form (PDF made in the app) ───────────────────────── */

const FALLBACK_CONTACT = { address: 'Munshirhat, Howrah – 711410', phone: '6296264592', email: 'successtutorialsofficial@gmail.com' };

/** Everything the app needs to draw the admission slip and form: the student, the institute and the rules. */
studentRouter.get('/documents', async (req, res) => {
  const s = studentOf(req);
  const [cat, settings] = await Promise.all([loadCatalog(), getSettings()]);
  const profile = await studentProfile(s, cat);
  const fee = feeOf(s, cat);
  const c = settings.contact;
  const fill: Record<string, string> = { '{admissionFee}': String(fee.admissionFee), '{monthlyFee}': String(fee.monthly), '{dueDay}': String(settings.dueDay) };
  res.json({
    student: profile,
    institute: {
      name: settings.instituteName,
      tagline: settings.tagline ?? '',
      centerHead: settings.centerHead,
      signature: settings.signature || undefined,
      address: c?.address && c.address !== 'Howrah, West Bengal' ? c.address : FALLBACK_CONTACT.address,
      phone: c?.phone || FALLBACK_CONTACT.phone,
      email: c?.email || FALLBACK_CONTACT.email,
    },
    dueDay: settings.dueDay,
    rules: (settings.admissionRules ?? []).map((r) => r.replace(/\{[a-zA-Z]+\}/g, (k) => fill[k] ?? k)),
  });
});

/* ───────────────────────── Account ───────────────────────── */

studentRouter.get('/me', async (req, res) => {
  res.json(await studentProfile(studentOf(req)));
});

/** Change password; every other signed-in device is signed out. */
studentRouter.put('/password', async (req, res) => {
  const body = parse(z.object({ current: z.string().max(200), next: zPassword }), req.body);
  const s = await Student.findById(studentOf(req)._id).select('+passwordHash');
  if (!s || !(await checkPassword(body.current, s.passwordHash))) throw unauthorized('Current password is wrong');
  s.passwordHash = await hashPassword(body.next);
  s.passwordChangedAt = new Date();
  await s.save();
  await revokeAllFor(s._id);
  res.status(204).end();
});

/** ID card data (the app renders and saves it as a PDF). */
studentRouter.get('/id-card', async (req, res) => {
  const s = studentOf(req);
  const [settings, cat, courses] = await Promise.all([getSettings(), loadCatalog(), Course.find(accessFilter(s), { title: 1 }).lean()]);
  const p = await studentProfile(s, cat);
  res.json({
    student: { ...p, guardianName: s.fatherName || s.motherName },
    courses: courses.map((c) => c.title),
    institute: { name: settings.instituteName, centerHead: settings.centerHead, signature: settings.signature, address: settings.contact?.address, phone: settings.contact?.phone },
    qr: `ST:${s.studentId}`,
  });
});

/* ───────────────────────── Home ───────────────────────── */

studentRouter.get('/home', async (req, res) => {
  const s = studentOf(req);
  const today = todayIST();
  const cat = await loadCatalog();
  const subjects = subjectNames(cat, s);
  const [notices, banners, settings, payments, exams, attendance, slots, changes] = await Promise.all([
    noticesForStudent(s).limit(5),
    Banner.find(appBannerFilter(s)).sort({ order: 1, createdAt: 1 }).lean(),
    getSettings(),
    Payment.find({ student: s._id, active: true }).lean(),
    Exam.find({ classId: s.classId, endsAt: { $gte: new Date(Date.now() - 86_400_000) } }, { questions: 0 }).sort({ startsAt: 1 }).limit(20).lean(),
    attendanceOf(s._id, { from: `${today.slice(0, 7)}-01`, to: today }),
    Slot.find({ groupId: { $in: [s.classId, ...s.extras] }, day: weekday(today) }).sort({ start: 1 }).lean(),
    RoutineChange.find({ groupId: { $in: [s.classId, ...s.extras] }, $or: [{ date: today }, { newDate: today }] }).lean(),
  ]);
  const fee = feeOf(s, cat);
  const ledger = ledgerFor(s, cat, payments, settings.dueDay, today);
  const mySlots = slots.filter((x) => s.extras.includes(x.groupId) || subjects.includes(x.subject)).filter((x) => !x.batch || !s.batch || x.batch === s.batch);
  res.json({
    student: await studentProfile(s, cat),
    banners: banners.map(appBannerView),
    notices,
    fees: summarise(ledger, fee.monthly),
    attendance: { month: today.slice(0, 7), held: attendance.held, present: attendance.present, percent: attendance.percent },
    today: mySlots.map((x) => {
      const ch = changes.find((c) => String(c.slot) === String(x._id) && c.date === today);
      return { id: String(x._id), group: groupName(cat, x.groupId), subject: x.subject, start: x.start, end: x.end, teacher: x.teacher, room: x.room, change: ch ? { kind: ch.kind, newDate: ch.newDate, newStart: ch.newStart, reason: ch.reason } : undefined };
    }),
    exams: exams
      .filter((e) => testIsFor(e, s, subjects))
      .map((e) => ({ id: String(e._id), title: e.title, subject: e.subject, date: e.date, start: e.start, duration: e.duration, status: examStatus(e) }))
      .filter((e) => e.status === 'LIVE' || e.status === 'SCHEDULED')
      .slice(0, 5),
  });
});

/* ───────────────────────── Fees (read-only — the teacher confirms payments in the admin) ───────────────────────── */

studentRouter.get('/fees', async (req, res) => {
  const s = studentOf(req);
  const [cat, settings, payments] = await Promise.all([loadCatalog(), getSettings(), Payment.find({ student: s._id, active: true }).sort({ receivedAt: -1 })]);
  const fee = feeOf(s, cat);
  const ledger = ledgerFor(s, cat, payments, settings.dueDay, todayIST());
  res.json({
    breakdown: fee,
    dueDay: settings.dueDay,
    summary: summarise(ledger, fee.monthly),
    months: ledger,
    receipts: payments.map((p) => ({ id: String(p._id), receiptNo: p.receiptNo, months: p.months, amount: p.amount, partial: !!p.partial, allocations: p.allocations ?? undefined, method: p.method, receivedAt: p.receivedAt, receivedBy: p.receivedBy })),
    // Pay by UPI (when the office turned it on); the office still confirms the payment.
    upi: settings.upi?.enabled && settings.upi.id ? { id: settings.upi.id, name: settings.upi.name || settings.instituteName, qrImage: settings.upi.qrImage || undefined, note: settings.upi.note ?? '' } : null,
  });
});

studentRouter.get('/receipts/:id', async (req, res) => {
  const id = parse(zId, req.params.id);
  const s = studentOf(req);
  const p = await Payment.findOne({ _id: id, student: s._id, active: true });
  if (!p) throw notFound('Receipt');
  const [settings, cat] = await Promise.all([getSettings(), loadCatalog()]);
  res.json({
    id: String(p._id),
    receiptNo: p.receiptNo,
    months: p.months,
    amount: p.amount,
    partial: !!p.partial,
    allocations: p.allocations ?? undefined,
    method: p.method,
    reference: p.reference,
    receivedAt: p.receivedAt,
    receivedBy: p.receivedBy,
    student: { name: s.name, studentId: s.studentId, className: cat.classes.get(s.classId)?.name ?? s.classId, batch: s.batch },
    institute: { name: settings.instituteName, address: settings.contact?.address, phone: settings.contact?.phone, centerHead: settings.centerHead, signature: settings.signature },
  });
});

/* ───────────────────────── Routine, attendance, notices ───────────────────────── */

/** Weekly routine — only the subjects the student takes and their extra curriculums — plus changes. */
studentRouter.get('/routine', async (req, res) => {
  const s = studentOf(req);
  const cat = await loadCatalog();
  const subjects = subjectNames(cat, s);
  const groups = [s.classId, ...s.extras];
  const today = todayIST();
  const [slots, changes] = await Promise.all([
    Slot.find({ groupId: { $in: groups } }).sort({ day: 1, start: 1 }).lean(),
    RoutineChange.find({ groupId: { $in: groups }, date: { $gte: addDays(today, -7), $lte: addDays(today, 60) } }).sort({ date: 1 }).lean(),
  ]);
  const mine = slots.filter((x) => (x.groupId === s.classId ? subjects.includes(x.subject) && (!x.batch || !s.batch || x.batch === s.batch) : true));
  const ids = new Set(mine.map((x) => String(x._id)));
  res.json({
    slots: mine.map((x) => ({ id: String(x._id), day: x.day, start: x.start, end: x.end, subject: x.subject, teacher: x.teacher, room: x.room, extra: x.groupId !== s.classId, group: groupName(cat, x.groupId) })),
    changes: changes
      .filter((c) => ids.has(String(c.slot)))
      .map((c) => ({ id: String(c._id), slotId: String(c.slot), date: c.date, kind: c.kind, newDate: c.newDate, newStart: c.newStart, newEnd: c.newEnd, reason: c.reason })),
  });
});

studentRouter.get('/attendance', async (req, res) => {
  const s = studentOf(req);
  const q = parse(z.object({ month: zMonth.optional(), from: zMonth.optional(), to: zMonth.optional() }), req.query);
  const today = todayIST();
  const fromM = q.month ?? q.from ?? today.slice(0, 7);
  const toM = q.month ?? q.to ?? fromM;
  const months = monthsBetween(fromM, toM);
  const last = months[months.length - 1]!;
  const lastDay = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const [range, overall] = await Promise.all([attendanceOf(s._id, { from: `${fromM}-01`, to: lastDay }), attendanceOf(s._id, { from: s.admissionDate, to: today })]);
  res.json({ ...range, overall: { held: overall.held, present: overall.present, percent: overall.percent } });
});

studentRouter.get('/notices', async (req, res) => {
  res.json(await noticesForStudent(studentOf(req)).limit(100));
});

studentRouter.get('/performance', async (req, res) => {
  const s = studentOf(req);
  res.json(await performanceOf(s, await loadCatalog()));
});

/* ───────────────────────── Learn: courses + free classes ───────────────────────── */

studentRouter.get('/courses', async (req, res) => {
  const s = studentOf(req);
  const [courses, done] = await Promise.all([Course.find(accessFilter(s)).sort({ createdAt: -1 }), LessonProgress.find({ student: s._id, done: true }, { course: 1 }).lean()]);
  res.json(
    courses.map((c) => ({
      id: String(c._id),
      title: c.title,
      subtitle: c.subtitle,
      cover: c.cover,
      teacher: c.teacher,
      modules: c.modules.length,
      lessons: lessonCount(c),
      done: done.filter((d) => String(d.course) === String(c._id)).length,
    })),
  );
});

studentRouter.get('/courses/:id', async (req, res) => {
  const id = parse(zId, req.params.id);
  const s = studentOf(req);
  const c = await Course.findOne({ _id: id, published: true });
  if (!c) throw notFound('Course');
  if (!hasAccess(c, s)) throw forbidden('This course is not part of your admission');
  const done = new Set((await LessonProgress.find({ student: s._id, course: c._id, done: true }, { lesson: 1 }).lean()).map((d) => String(d.lesson)));
  const json = c.toJSON() as unknown as Record<string, unknown> & { modules: { lessons: { id: string }[] }[] };
  json.modules.forEach((m) => m.lessons.forEach((l) => Object.assign(l, { done: done.has(l.id) })));
  delete json.access;
  res.json(json);
});

studentRouter.put('/lessons/:id/progress', async (req, res) => {
  const lessonId = parse(zId, req.params.id);
  const { done } = parse(z.object({ done: z.boolean() }), req.body);
  const s = studentOf(req);
  const c = await Course.findOne({ published: true, 'modules.lessons._id': lessonId }, { access: 1 });
  if (!c || !hasAccess(c, s)) throw notFound('Lesson');
  await LessonProgress.updateOne({ student: s._id, lesson: lessonId }, { $set: { done, course: c._id } }, { upsert: true });
  res.status(204).end();
});

/** Free YouTube classes; defaults to the student's own class. */
studentRouter.get('/free-videos', async (req, res) => {
  const q = parse(z.object({ classId: z.string().max(40).optional() }), req.query);
  res.json(await FreeVideo.find({ classId: q.classId ?? studentOf(req).classId, published: true }).sort({ order: 1, createdAt: -1 }));
});

studentRouter.use(studentTestsRouter);
