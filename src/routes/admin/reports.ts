import { Router } from 'express';
import { z } from 'zod';

import { badRequest } from '../../lib/errors.js';
import { signDocuments } from '../../lib/files.js';
import { addDays, istInstant, monthsBetween, todayIST, weekday } from '../../lib/time.js';
import { parse, zCode, zId } from '../../lib/validate.js';
import { Notice } from '../../models/content.js';
import { getSettings } from '../../models/org.js';
import { Attendance, RoutineChange, Slot } from '../../models/schedule.js';
import { Application, Feedback, Payment, Student } from '../../models/students.js';
import { Exam, ExamSubmission, examStatus } from '../../models/tests.js';
import { groupName, loadCatalog, subjectNames } from '../../services/catalog.js';
import { summariesFor } from '../../services/dues.js';
import { feeOf } from '../../services/fees.js';
import { liveFilter } from '../../services/notices.js';
import { reportCards } from '../../services/reportCards.js';

export const reportsRouter = Router();

/* ───────────────────────── Dashboard ───────────────────────── */

reportsRouter.get('/dashboard', async (_req, res) => {
  const today = todayIST();
  const monthStart = `${today.slice(0, 7)}-01`;
  const cat = await loadCatalog();
  const settings = await getSettings();
  const sixMonths = monthsBetween(addDays(monthStart, -160), today).slice(-6);

  const [students, pendingApps, pendingCount, todayPay, monthPay, recent, regsToday, slots, changes, exams, notices, topper, byMonth] = await Promise.all([
    Student.find({ status: 'ACTIVE' }).lean(),
    Application.find({ status: 'PENDING' }).sort({ createdAt: -1 }).limit(5),
    Application.countDocuments({ status: 'PENDING' }),
    Payment.aggregate<{ t: number; n: number }>([{ $match: { active: true, receivedAt: { $gte: istInstant(today) } } }, { $group: { _id: null, t: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    Payment.aggregate<{ t: number }>([{ $match: { active: true, receivedAt: { $gte: istInstant(monthStart) } } }, { $group: { _id: null, t: { $sum: '$amount' } } }]),
    Payment.find({ active: true }).sort({ receivedAt: -1 }).limit(8).populate('student', 'name studentId classId photo'),
    Attendance.countDocuments({ date: today }),
    Slot.find({ day: weekday(today) }).sort({ start: 1 }).lean(),
    RoutineChange.find({ $or: [{ date: today }, { newDate: today }] }).lean(),
    Exam.find({ endsAt: { $gte: istInstant(addDays(today, -30)) } }, { questions: 0 }).sort({ startsAt: 1 }).lean(),
    Notice.find(liveFilter()).sort({ pinned: -1, publishAt: -1 }).limit(5),
    Notice.findOne({ kind: 'TOPPER' }).sort({ createdAt: -1 }),
    Payment.aggregate<{ _id: string; t: number }>([
      { $match: { active: true, receivedAt: { $gte: istInstant(`${sixMonths[0]}-01`) } } },
      { $group: { _id: { $dateToString: { date: '$receivedAt', format: '%Y-%m', timezone: 'Asia/Kolkata' } }, t: { $sum: '$amount' } } },
    ]),
  ]);

  const dues = await summariesFor(students, cat, settings.dueDay, today);
  const pending = [...dues.values()].reduce((a, d) => a + d.pending, 0);
  const overdue = students
    .map((s) => ({ s, d: dues.get(String(s._id))! }))
    .filter((x) => x.d.status === 'OVERDUE')
    .sort((a, b) => b.d.pending - a.d.pending)
    .slice(0, 10)
    .map(({ s, d }) => ({ id: String(s._id), name: s.name, studentId: s.studentId, className: groupName(cat, s.classId), phone: s.phone, pending: d.pending, months: d.overdueMonths }));
  const now = new Date();
  const examRows = exams.map((e) => ({ id: String(e._id), title: e.title, classId: e.classId, className: groupName(cat, e.classId), subject: e.subject, date: e.date, start: e.start, status: examStatus(e, now) }));
  const strength = [...cat.classes.values()].map((c) => ({ id: c._id, name: c.name, students: students.filter((s) => s.classId === c._id).length }));
  const m = new Map(byMonth.map((x) => [x._id, x.t]));

  res.json({
    kpis: {
      activeStudents: students.length,
      pendingRequests: pendingCount,
      receivedToday: todayPay[0]?.t ?? 0,
      paymentsToday: todayPay[0]?.n ?? 0,
      collectedThisMonth: monthPay[0]?.t ?? 0,
      feesPending: pending,
      registersToday: regsToday,
    },
    attention: {
      pendingRequests: pendingCount,
      liveExams: examRows.filter((e) => e.status === 'LIVE').length,
      resultsToPublish: examRows.filter((e) => e.status === 'ENDED').length,
    },
    pendingRequests: pendingApps.map((a) => ({ id: String(a._id), ref: a.ref, name: a.name, className: groupName(cat, a.classId), submittedAt: a.get('createdAt'), monthlyFee: feeOf(a, cat).monthly })),
    recentPayments: recent,
    todayClasses: slots.map((x) => {
      const ch = changes.find((c) => String(c.slot) === String(x._id));
      return { id: String(x._id), group: groupName(cat, x.groupId), groupId: x.groupId, batch: x.batch, subject: x.subject, start: x.start, end: x.end, teacher: x.teacher, room: x.room, change: ch ? { kind: ch.kind, newDate: ch.newDate, newStart: ch.newStart } : undefined };
    }),
    collection: sixMonths.map((k) => ({ month: k, amount: m.get(k) ?? 0 })),
    exams: examRows.filter((e) => e.status !== 'PUBLISHED').slice(0, 8),
    overdue,
    classStrength: strength,
    notices,
    latestTopper: topper,
  });
});

/* ───────────────────────── Annual report card ───────────────────────── */

/** Report cards for one student or a whole class, for a session such as 2026-27. */
reportsRouter.get('/report-cards', async (req, res) => {
  const q = parse(z.object({ session: z.string().regex(/^\d{4}-\d{2}$/).optional(), studentId: zId.optional(), classId: zCode.optional() }), req.query);
  if (!q.studentId && !q.classId) throw badRequest('Pick a student or a class');
  res.json(await reportCards(q));
});

/* ───────────────────────── Backup ───────────────────────── */

/**
 * Everything for the backup workbook, sheet by sheet (the panel writes the .xlsx). All classes or one.
 */
reportsRouter.get('/backup', async (req, res) => {
  const q = parse(z.object({ classId: zCode.optional() }), req.query);
  const cat = await loadCatalog();
  const settings = await getSettings();
  const today = todayIST();
  const students = await Student.find(q.classId ? { classId: q.classId } : {}).sort({ classId: 1, name: 1 }).lean();
  const ids = students.map((s) => s._id);
  const name = new Map(students.map((s) => [String(s._id), s]));
  const [dues, payments, regs, attempts, feedback] = await Promise.all([
    summariesFor(students, cat, settings.dueDay, today),
    Payment.find({ student: { $in: ids } }).sort({ receivedAt: 1 }).lean(),
    Attendance.find({ 'marks.student': { $in: ids } }).sort({ date: 1 }).lean(),
    ExamSubmission.find({ student: { $in: ids } }).lean(),
    Feedback.find({ student: { $in: ids } }).sort({ at: 1 }).lean(),
  ]);
  const exams = await Exam.find({ _id: { $in: [...new Set(attempts.map((a) => String(a.exam)))] } }, { questions: 0 }).lean();
  const examById = new Map(exams.map((e) => [String(e._id), e]));
  const sid = (id: unknown) => name.get(String(id))?.studentId ?? '';
  const sname = (id: unknown) => name.get(String(id))?.name ?? '';

  res.json({
    generatedAt: new Date(),
    classId: q.classId ?? null,
    sheets: {
      Students: students.map((s) => ({
        'Student ID': s.studentId,
        Name: s.name,
        Class: groupName(cat, s.classId),
        Batch: s.batch,
        Phone: s.phone,
        Gender: s.gender,
        'Date of birth': s.dob,
        Email: s.email ?? '',
        Aadhaar: s.aadhaar,
        'Father name': s.fatherName,
        'Mother name': s.motherName,
        'Guardian phone': s.guardianPhone,
        School: s.school,
        Board: s.board,
        'Target exams': s.targetExams.join(', '),
        Subjects: subjectNames(cat, s).join(', '),
        'Extra curriculums': s.extras.map((e) => groupName(cat, e)).join(', '),
        'Admission date': s.admissionDate,
        'Duration (months)': s.durationMonths,
        'Valid till': s.validTill,
        'Monthly discount': s.discount,
        Status: s.status,
        Documents: Object.keys(signDocuments(s.documents)).join(', '),
      })),
      'Fees summary': students.map((s) => {
        const d = dues.get(String(s._id))!;
        return { 'Student ID': s.studentId, Name: s.name, Class: groupName(cat, s.classId), 'Monthly fee': d.monthly, Paid: d.paid, Pending: d.pending, 'Overdue months': d.overdueMonths, Status: d.status };
      }),
      Payments: payments.map((p) => ({
        'Receipt no': p.receiptNo,
        'Student ID': sid(p.student),
        Name: sname(p.student),
        Months: p.months.join(', '),
        Amount: p.amount,
        Method: p.method,
        Reference: p.reference ?? '',
        'Received at': p.receivedAt.toISOString(),
        'Received by': p.receivedBy,
        Removed: p.active ? '' : `Yes — ${p.voidReason ?? ''}`,
      })),
      Attendance: regs.flatMap((r) =>
        r.marks.filter((m) => name.has(String(m.student))).map((m) => ({ Date: r.date, Group: groupName(cat, r.groupId), Batch: r.batch, 'Student ID': sid(m.student), Name: sname(m.student), Mark: m.mark })),
      ),
      'Exam results': attempts.map((a) => {
        const e = examById.get(String(a.exam));
        return {
          Exam: e?.title ?? '',
          Date: e?.date ?? '',
          Subject: e?.subject ?? '',
          'Student ID': sid(a.student),
          Name: sname(a.student),
          'Answer sheet': a.mode === 'UPLOAD' ? 'Uploaded PDF' : 'Notebook handed in',
          Status: a.status === 'CHECKED' ? 'Checked' : a.status === 'ABSENT' ? 'Absent' : 'Not checked',
          Marks: a.total ?? '',
          'Full marks': e?.fullMarks ?? '',
          Remarks: a.remarks ?? '',
        };
      }),
      'Teacher feedback': feedback.map((f) => ({ Date: f.at.toISOString().slice(0, 10), 'Student ID': sid(f.student), Name: sname(f.student), Feedback: f.text, By: f.by })),
    },
  });
});
