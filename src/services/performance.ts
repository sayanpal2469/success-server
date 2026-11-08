import type { Types } from 'mongoose';

import { todayIST } from '../lib/time.js';
import { Attempt, Exam, ExamSubmission, MockTest } from '../models/tests.js';
import { Attendance } from '../models/schedule.js';
import { Feedback, type StudentDoc } from '../models/students.js';
import { subjectNames, type Catalog } from './catalog.js';
import { rank, testIsFor, totalMarks } from './tests.js';

type Range = { from?: string; to?: string };

/** Class attendance from the registers the student was on. */
export async function attendanceOf(studentId: Types.ObjectId, range: Range = {}) {
  const date: Record<string, string> = {};
  if (range.from) date.$gte = range.from;
  if (range.to) date.$lte = range.to;
  const regs = await Attendance.find({ 'marks.student': studentId, ...(range.from || range.to ? { date } : {}) }, { date: 1, groupId: 1, marks: { $elemMatch: { student: studentId } } })
    .sort({ date: 1 })
    .lean();
  const days = regs.map((r) => ({ date: r.date, groupId: r.groupId, mark: r.marks[0]?.mark ?? 'A' }));
  const present = days.filter((d) => d.mark === 'P').length;
  return { held: days.length, present, absent: days.length - present, percent: days.length ? Math.round((present / days.length) * 1000) / 10 : null, days };
}

export type ExamLine = {
  examId: string;
  title: string;
  subject: string;
  date: string;
  total: number;
  attended: boolean;
  score?: number;
  percent?: number;
  rank?: number;
  of: number;
  topper: number;
  average: number;
};

/** Published written exam results for the student's class and subjects, oldest first (for the trend line). Mock tests are separate. */
export async function examLinesOf(s: StudentDoc, cat: Catalog, range: Range = {}): Promise<ExamLine[]> {
  const subjects = subjectNames(cat, s);
  const q: Record<string, unknown> = { classId: s.classId, resultsPublished: true };
  if (range.from || range.to) q.date = { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lte: range.to } : {}) };
  const exams = (await Exam.find(q, { questions: 0 }).sort({ date: 1, start: 1 }).lean()).filter((e) => testIsFor(e, s, subjects));
  if (!exams.length) return [];
  const sheets = await ExamSubmission.find({ exam: { $in: exams.map((e) => e._id) }, status: 'CHECKED' }, { exam: 1, student: 1, total: 1 }).lean();
  return exams.map((e) => {
    const rows = rank(sheets.filter((x) => String(x.exam) === String(e._id)).map((x) => ({ student: String(x.student), score: x.total ?? 0, timeSec: 0 })));
    const me = rows.find((r) => r.student === String(s._id));
    const total = e.fullMarks ?? 0;
    const avg = rows.length ? rows.reduce((a, r) => a + r.score, 0) / rows.length : 0;
    return {
      examId: String(e._id),
      title: e.title,
      subject: e.subject,
      date: e.date,
      total,
      attended: !!me,
      score: me?.score,
      percent: me && total ? Math.round((me.score / total) * 1000) / 10 : undefined,
      rank: me?.rank,
      of: rows.length,
      topper: rows[0]?.score ?? 0,
      average: Math.round(avg * 10) / 10,
    };
  });
}

/** Best and latest score on every mock test the student tried. */
export async function mockLinesOf(studentId: Types.ObjectId) {
  const attempts = await Attempt.find({ kind: 'MOCK', student: studentId, status: 'SUBMITTED' }).sort({ submittedAt: 1 }).lean();
  if (!attempts.length) return [];
  const mocks = await MockTest.find({ _id: { $in: [...new Set(attempts.map((a) => String(a.test)))] } }).lean();
  return mocks.map((m) => {
    const mine = attempts.filter((a) => String(a.test) === String(m._id));
    const best = Math.max(...mine.map((a) => a.score ?? 0));
    const last = mine[mine.length - 1]!;
    return { mockId: String(m._id), title: m.title, subject: m.subject, total: totalMarks(m), attempts: mine.length, best, last: last.score ?? 0, lastAt: last.submittedAt };
  });
}

export async function feedbackOf(studentId: Types.ObjectId) {
  return Feedback.find({ student: studentId }).sort({ at: -1 });
}

/** Everything the performance tracker shows (admin Performance tab and the app). */
export async function performanceOf(s: StudentDoc, cat: Catalog, range: Range = {}) {
  const [attendance, exams, mocks, feedback] = await Promise.all([attendanceOf(s._id, range), examLinesOf(s, cat, range), mockLinesOf(s._id), feedbackOf(s._id)]);
  const sat = exams.filter((e) => e.attended);
  return {
    attendance,
    exams,
    examAttendance: { held: exams.length, attended: sat.length, missed: exams.length - sat.length },
    examAverage: sat.length ? Math.round((sat.reduce((a, e) => a + (e.percent ?? 0), 0) / sat.length) * 10) / 10 : null,
    mocks,
    feedback: feedback.map((f) => f.toJSON()),
    asOf: todayIST(),
  };
}
