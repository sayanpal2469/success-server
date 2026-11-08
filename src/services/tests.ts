import type { Types } from 'mongoose';

import { conflict, unprocessable } from '../lib/errors.js';
import { addDays, istInstant, todayIST } from '../lib/time.js';
import { ALL_SUBJECTS } from '../models/catalog.js';
import { Student } from '../models/students.js';
import { Attempt, ExamSubmission, mockStatus, type AttemptDoc, type ExamDoc, type MockDoc, type QuestionDoc } from '../models/tests.js';
import { deletedStudentIds } from './studentDelete.js';

/** Answers saved a little after the deadline still count — covers network lag on the last tap. */
export const GRACE_MS = 30_000;

type Scored = Pick<MockDoc, 'questions' | 'marksPerQ' | 'negative'>;
type AnyTest = MockDoc & { _id: Types.ObjectId };

/** Full marks of an online mock test. */
export const totalMarks = (t: Scored) => t.questions.length * t.marksPerQ;
/** Full marks of a written exam (sum of the question marks). */
export const examTotal = (e: Pick<ExamDoc, 'questions' | 'fullMarks'>) => e.fullMarks || e.questions.reduce((a, q) => a + (q.marks ?? 0), 0);

/** Questions as the student sees them during an attempt — no answer key. */
export const publicQuestions = (qs: QuestionDoc[]) => qs.map((q) => ({ id: String(q._id), q: q.q, options: q.options }));

export function score(t: Scored, answers: Map<string, number>) {
  let correct = 0;
  let wrong = 0;
  for (const q of t.questions) {
    const a = answers.get(String(q._id));
    if (a === undefined) continue;
    if (a === q.answer) correct++;
    else wrong++;
  }
  const skipped = t.questions.length - correct - wrong;
  const raw = correct * t.marksPerQ - wrong * t.negative;
  return { correct, wrong, skipped, score: Math.round(raw * 100) / 100 };
}

type AttemptRow = AttemptDoc & { save(): Promise<unknown> };

/** Closes an attempt with whatever was saved; used on submit and for attempts left open past the deadline. */
export async function finalize(attempt: AttemptRow, test: Scored, at = new Date()) {
  if (attempt.status === 'SUBMITTED') return attempt;
  const end = at > attempt.deadline ? attempt.deadline : at;
  Object.assign(attempt, score(test, attempt.answers), {
    status: 'SUBMITTED',
    submittedAt: end,
    timeSec: Math.max(0, Math.round((end.getTime() - attempt.startedAt.getTime()) / 1000)),
  });
  await attempt.save();
  return attempt;
}

/** Finalises every open attempt of a test whose deadline (+ grace) has passed. */
export async function sweepExpired(kind: 'MOCK', test: AnyTest) {
  const stale = await Attempt.find({ kind, test: test._id, status: 'IN_PROGRESS', deadline: { $lt: new Date(Date.now() - GRACE_MS) } });
  for (const a of stale) await finalize(a, test, a.deadline);
}

/** Whether a test is meant for a student: same class and a subject they take (or a mixed test). */
export const testIsFor = (t: { classId: string; subject: string }, s: { classId: string }, subjects: string[]) =>
  t.classId === s.classId && (t.subject === ALL_SUBJECTS || subjects.includes(t.subject));

/** Starts (or resumes) a mock attempt: while open, up to `attemptsAllowed`, each gets the full duration. */
export async function startAttempt(kind: 'MOCK', test: AnyTest, studentId: Types.ObjectId) {
  const now = new Date();
  const mine = await Attempt.find({ kind, test: test._id, student: studentId }).sort({ attemptNo: -1 });
  const open = mine.find((a) => a.status === 'IN_PROGRESS');
  if (open && now.getTime() <= open.deadline.getTime() + GRACE_MS) return open;
  if (open) await finalize(open, test, open.deadline);

  const m = test;
  const st = mockStatus(m, todayIST(now));
  if (st !== 'OPEN') throw unprocessable('CLOSED', st === 'UPCOMING' ? 'This mock test is not open yet' : 'This mock test is closed');
  if (m.attemptsAllowed > 0 && mine.length >= m.attemptsAllowed) throw conflict(`You have used all ${m.attemptsAllowed} attempt(s)`);
  let deadline = new Date(now.getTime() + m.duration * 60_000);
  if (m.openTill) {
    const close = istInstant(addDays(m.openTill, 1));
    if (close < deadline) deadline = close;
  }

  try {
    return await Attempt.create({ kind, test: test._id, student: studentId, attemptNo: (mine[0]?.attemptNo ?? 0) + 1, startedAt: now, deadline });
  } catch (e) {
    // A second tap raced us to the same attempt number — hand back the one that won.
    if ((e as { code?: number }).code === 11000) {
      const again = await Attempt.findOne({ kind, test: test._id, student: studentId, status: 'IN_PROGRESS' });
      if (again) return again;
    }
    throw e;
  }
}

/** Merges answers into an open attempt. Unknown question ids and late saves are rejected. */
export async function saveAnswers(attempt: AttemptRow, test: Scored, answers: Record<string, number | null>, appSwitches?: number) {
  if (attempt.status !== 'IN_PROGRESS') throw conflict('This attempt is already submitted');
  if (Date.now() > attempt.deadline.getTime() + GRACE_MS) throw unprocessable('TIME_UP', 'Time is up — your saved answers will be submitted');
  const ids = new Set(test.questions.map((q) => String(q._id)));
  for (const [qid, a] of Object.entries(answers)) {
    if (!ids.has(qid)) throw unprocessable('BAD_QUESTION', 'Unknown question in answers');
    if (a === null) attempt.answers.delete(qid);
    else attempt.answers.set(qid, a);
  }
  if (appSwitches !== undefined) attempt.appSwitches = Math.max(attempt.appSwitches ?? 0, appSwitches);
  await attempt.save();
  return attempt;
}

export type RankedRow = { student: string; score: number; correct: number; wrong: number; skipped: number; timeSec: number; rank: number; attemptId: string; submittedAt?: Date };

/** Best score first, then fastest; equal score and time share a rank (1, 2, 2, 4). */
export function rank<T extends { score: number; timeSec: number }>(rows: T[]): (T & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score || a.timeSec - b.timeSec);
  const out: (T & { rank: number })[] = [];
  sorted.forEach((r, i) => {
    const prev = out[i - 1];
    out.push({ ...r, rank: prev && prev.score === r.score && prev.timeSec === r.timeSec ? prev.rank : i + 1 });
  });
  return out;
}

export type ExamRow = { student: string; score: number; rank: number; submissionId: string; mode: string; submittedAt?: Date; timeSec: number };

/**
 * Written exam results from the marks the admin entered: checked sheets ranked by marks (equal
 * marks share a rank), plus absent students (marked absent, or nothing recorded) and sheets still
 * waiting to be checked.
 */
export async function examResults(exam: ExamDoc & { _id: Types.ObjectId }, subjectOf: (s: { classId: string; subjectIds: string[] }) => string[]) {
  // Soft-deleted students drop out of the results until restored.
  const [all, gone] = await Promise.all([ExamSubmission.find({ exam: exam._id }).lean(), deletedStudentIds()]);
  const subs = all.filter((x) => !gone.has(String(x.student)));
  const ranked: ExamRow[] = rank(
    subs
      .filter((x) => x.status === 'CHECKED' && typeof x.total === 'number')
      .map((x) => ({ student: String(x.student), score: x.total ?? 0, timeSec: 0, submissionId: String(x._id), mode: x.mode, submittedAt: x.submittedAt ?? undefined })),
  );
  const checked = new Set(ranked.map((r) => r.student));
  const pendingIds = new Set(subs.filter((x) => x.status === 'SUBMITTED').map((x) => String(x.student)));
  const pool = await Student.find({ classId: exam.classId, status: 'ACTIVE' }, { name: 1, studentId: 1, classId: 1, subjectIds: 1, batch: 1, photo: 1 }).lean();
  const eligible = pool.filter((s) => testIsFor(exam, s, subjectOf(s)));
  const absent = eligible.filter((s) => !checked.has(String(s._id)) && !pendingIds.has(String(s._id)));
  const pending = eligible.filter((s) => pendingIds.has(String(s._id)));
  return { ranked, absent, pending, total: examTotal(exam) };
}

/** A Map field as a plain object (lean() gives an object, a document gives a Map). */
export const marksObj = (m: unknown) => (!m ? undefined : m instanceof Map ? (Object.fromEntries(m) as Record<string, number>) : (m as Record<string, number>));

/** Percentage → grade, the same scale as the report cards. */
export function grade(pct: number) {
  if (pct >= 90) return 'A+';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B+';
  if (pct >= 60) return 'B';
  if (pct >= 50) return 'C';
  if (pct >= 40) return 'D';
  return 'E';
}

/** Same ranking for one student's view of a mock test (best attempt per student). */
export async function mockBoard(mock: MockDoc & { _id: Types.ObjectId }) {
  await sweepExpired('MOCK', mock);
  const [all, gone] = await Promise.all([Attempt.find({ kind: 'MOCK', test: mock._id, status: 'SUBMITTED' }).sort({ submittedAt: 1 }).lean(), deletedStudentIds()]);
  const attempts = all.filter((a) => !gone.has(String(a.student)));
  const by = new Map<string, { student: string; attempts: number; best: number; last: number; lastAt?: Date; timeSec: number; score: number }>();
  for (const a of attempts) {
    const k = String(a.student);
    const cur = by.get(k);
    const sc = a.score ?? 0;
    if (!cur) by.set(k, { student: k, attempts: 1, best: sc, last: sc, lastAt: a.submittedAt ?? undefined, timeSec: a.timeSec ?? 0, score: sc });
    else {
      cur.attempts++;
      cur.last = sc;
      cur.lastAt = a.submittedAt ?? cur.lastAt;
      if (sc > cur.best || (sc === cur.best && (a.timeSec ?? 0) < cur.timeSec)) Object.assign(cur, { best: sc, score: sc, timeSec: a.timeSec ?? 0 });
    }
  }
  return rank([...by.values()]);
}

/** Result of one finished attempt, with the answer key only when allowed. */
export function attemptReview(t: Scored & { showAnswers?: boolean }, a: AttemptDoc, withKey: boolean) {
  return {
    id: String(a._id),
    status: a.status,
    score: a.score ?? 0,
    total: totalMarks(t),
    correct: a.correct ?? 0,
    wrong: a.wrong ?? 0,
    skipped: a.skipped ?? 0,
    timeSec: a.timeSec ?? 0,
    submittedAt: a.submittedAt,
    answers: Object.fromEntries(a.answers),
    questions: t.questions.map((q) => ({
      id: String(q._id),
      q: q.q,
      options: q.options,
      ...(withKey ? { answer: q.answer, explanation: q.explanation } : {}),
    })),
  };
}
