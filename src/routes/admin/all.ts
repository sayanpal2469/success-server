import { Router } from 'express';
import { z } from 'zod';

import { addDays, todayIST } from '../../lib/time.js';
import { parse, zDate } from '../../lib/validate.js';
import { Attendance } from '../../models/schedule.js';
import { Feedback, Payment, Student } from '../../models/students.js';
import { Exam, examStatus, MockTest } from '../../models/tests.js';
import { loadCatalog, subjectNames } from '../../services/catalog.js';
import { examResults, mockBoard } from '../../services/tests.js';
import { deletedStudentIds } from '../../services/studentDelete.js';
import { adminStudentView } from './students.js';

/**
 * Whole collections in one go for the admin panel, which keeps its data in memory and computes its
 * own views (the institute has a few hundred students, so this stays small).
 */
export const allRouter = Router();

allRouter.get('/all/students', async (_req, res) => {
  const [rows, cat] = await Promise.all([Student.find().sort({ createdAt: -1 }), loadCatalog()]);
  res.json(await Promise.all(rows.map((s) => adminStudentView(s, cat))));
});

allRouter.get('/all/payments', async (_req, res) => {
  const [rows, gone] = await Promise.all([Payment.find({ active: true }).sort({ receivedAt: -1 }).lean(), deletedStudentIds()]);
  res.json(
    rows.filter((p) => !gone.has(String(p.student))).map((p) => ({
      id: String(p._id),
      receiptNo: p.receiptNo,
      studentId: String(p.student),
      months: p.months,
      amount: p.amount,
      allocations: p.allocations ?? undefined,
      partial: !!p.partial,
      method: p.method,
      reference: p.reference,
      note: p.note,
      at: p.receivedAt,
      receivedBy: p.receivedBy,
    })),
  );
});

/** Registers as `{ groupId, date, batch, marks: { studentId: 'P' | 'A' } }`, default the last 13 months. */
allRouter.get('/all/attendance', async (req, res) => {
  const q = parse(z.object({ from: zDate.optional() }), req.query);
  const [rows, gone] = await Promise.all([Attendance.find({ date: { $gte: q.from ?? addDays(todayIST(), -400) } }).lean(), deletedStudentIds()]);
  res.json(rows.map((r) => ({ groupId: r.groupId, date: r.date, batch: r.batch, checkInOnly: !!r.checkInOnly, marks: Object.fromEntries(r.marks.filter((m) => !gone.has(String(m.student))).map((m) => [String(m.student), m.mark])) })));
});

/** Marked results of every written exam that has started: `{ examId: rows[] }` (unchecked and absent students included). */
allRouter.get('/all/results', async (_req, res) => {
  const cat = await loadCatalog();
  const exams = await Exam.find({ startsAt: { $lte: new Date() } });
  const out: Record<string, unknown[]> = {};
  for (const e of exams) {
    if (examStatus(e) === 'SCHEDULED') continue;
    const { ranked, absent, pending } = await examResults(e, (s) => subjectNames(cat, s));
    out[String(e._id)] = [
      ...ranked.map((r) => ({ id: r.submissionId, studentId: r.student, attended: true, score: r.score, mode: r.mode, rank: r.rank })),
      ...pending.map((s) => ({ id: `pending-${String(s._id)}`, studentId: String(s._id), attended: false, pending: true, score: 0, rank: 0 })),
      ...absent.map((s) => ({ id: `absent-${String(s._id)}`, studentId: String(s._id), attended: false, score: 0, rank: 0 })),
    ];
  }
  res.json(out);
});

/** Best / last score per student for every mock test: `{ mockId: rows[] }`. */
allRouter.get('/all/mock-results', async (_req, res) => {
  const mocks = await MockTest.find({ published: true });
  const out: Record<string, unknown[]> = {};
  for (const m of mocks) {
    const board = await mockBoard(m);
    out[String(m._id)] = board.map((b) => ({ id: `${String(m._id)}-${b.student}`, studentId: b.student, attempts: b.attempts, best: b.best, last: b.last, lastAt: b.lastAt?.toISOString().slice(0, 10), time: Math.round(b.timeSec / 60), rank: b.rank }));
  }
  res.json(out);
});

allRouter.get('/all/feedback', async (_req, res) => {
  const [rows, gone] = await Promise.all([Feedback.find().sort({ at: -1 }).lean(), deletedStudentIds()]);
  res.json(rows.filter((f) => !gone.has(String(f.student))).map((f) => ({ id: String(f._id), studentId: String(f.student), examId: f.exam ? String(f.exam) : undefined, text: f.text, by: f.by, at: f.at })));
});

/** Exams and mock tests with their questions (and answer keys — admin only). */
allRouter.get('/all/exams', async (_req, res) => {
  res.json(await Exam.find().sort({ startsAt: -1 }));
});

allRouter.get('/all/mocks', async (_req, res) => {
  res.json(await MockTest.find().sort({ openFrom: -1 }));
});
