import { Router, type Request } from 'express';
import { z } from 'zod';

import { studentOf } from '../../lib/auth.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { todayIST } from '../../lib/time.js';
import { parse, zId } from '../../lib/validate.js';
import { Attempt, Exam, ExamSubmission, examStatus, MockTest, mockStatus, uploadDeadline } from '../../models/tests.js';
import { loadCatalog, subjectNames } from '../../services/catalog.js';
import { attemptReview, examResults, examTotal, finalize, grade, marksObj, mockBoard, publicQuestions, saveAnswers, startAttempt, testIsFor, totalMarks } from '../../services/tests.js';

export const studentTestsRouter = Router();

const mySubjects = async (s: { classId: string; subjectIds: string[] }) => subjectNames(await loadCatalog(), s);

/** App status for an exam: UPCOMING → LIVE → RESULT_PENDING → RESULT. */
const appExamStatus = (st: ReturnType<typeof examStatus>) => ({ SCHEDULED: 'UPCOMING', LIVE: 'LIVE', ENDED: 'RESULT_PENDING', PUBLISHED: 'RESULT' })[st];

/** Written exams and online mock tests for the student's class and subjects. */
studentTestsRouter.get('/tests', async (req, res) => {
  const s = studentOf(req);
  const subjects = await mySubjects(s);
  const today = todayIST();
  const [exams, mocks, attempts, subs] = await Promise.all([
    Exam.aggregate([{ $match: { classId: s.classId } }, { $addFields: { count: { $size: '$questions' } } }, { $project: { questions: 0 } }, { $sort: { startsAt: -1 } }]),
    MockTest.aggregate([{ $match: { classId: s.classId, published: true } }, { $addFields: { count: { $size: '$questions' } } }, { $project: { questions: 0 } }, { $sort: { openFrom: -1 } }]),
    Attempt.find({ student: s._id, kind: 'MOCK' }, { kind: 1, test: 1, status: 1, score: 1, attemptNo: 1 }).lean(),
    ExamSubmission.find({ student: s._id }, { exam: 1, mode: 1, status: 1, submittedAt: 1, total: 1 }).lean(),
  ]);
  const sheets = new Map(subs.map((x) => [String(x.exam), x]));
  const mine = (id: unknown) => attempts.filter((a) => String(a.test) === String(id));
  res.json({
    exams: exams
      .filter((e) => testIsFor(e, s, subjects))
      .map((e) => {
        const x = sheets.get(String(e._id));
        const st = examStatus(e);
        return {
          id: String(e._id),
          kind: 'EXAM',
          title: e.title,
          subject: e.subject,
          date: e.date,
          start: e.start,
          duration: e.duration,
          questions: e.count,
          total: e.fullMarks,
          status: appExamStatus(st),
          paperOpen: st !== 'SCHEDULED',
          uploadTill: uploadDeadline(e),
          submission: x ? { mode: x.mode, status: x.status, submittedAt: x.submittedAt } : null,
          submitted: !!x && x.status !== 'ABSENT',
          score: st === 'PUBLISHED' && x?.status === 'CHECKED' ? x.total : undefined,
        };
      }),
    mocks: mocks
      .filter((m) => testIsFor(m, s, subjects))
      .map((m) => {
        const tries = mine(m._id).filter((a) => a.status === 'SUBMITTED');
        const st = mockStatus(m, today);
        const left = m.attemptsAllowed ? Math.max(0, m.attemptsAllowed - tries.length) : null;
        return {
          id: String(m._id),
          kind: 'MOCK',
          title: m.title,
          subject: m.subject,
          duration: m.duration,
          questions: m.count,
          marksPerQ: m.marksPerQ,
          negative: m.negative,
          total: m.count * m.marksPerQ,
          openFrom: m.openFrom,
          openTill: m.openTill,
          attemptsAllowed: m.attemptsAllowed,
          attemptsUsed: tries.length,
          attemptsLeft: left,
          best: tries.length ? Math.max(...tries.map((a) => a.score ?? 0)) : undefined,
          status: st === 'OPEN' && left === 0 ? 'DONE' : st,
        };
      }),
  });
});

/* ───────────────────────── Exams ───────────────────────── */

async function myExam(req: Request) {
  const id = parse(zId, req.params.id);
  const s = studentOf(req);
  const e = await Exam.findById(id);
  if (!e || !testIsFor(e, s, await mySubjects(s))) throw notFound('Exam');
  return e;
}

const sheetView = (x: { mode: string; status: string; submittedAt?: Date | null; late?: boolean | null; pages?: number | null } | null) =>
  x ? { mode: x.mode, status: x.status, submittedAt: x.submittedAt ?? undefined, late: !!x.late, pages: x.pages ?? undefined } : null;

/**
 * Exam details. The question paper (questions) is sent from the start time; before that only the
 * schedule. `canUpload` / `canHandIn` say what the student can do with their answer sheet now.
 */
studentTestsRouter.get('/exams/:id', async (req, res) => {
  const e = await myExam(req);
  const x = await ExamSubmission.findOne({ exam: e._id, student: studentOf(req)._id }).lean();
  const st = examStatus(e);
  const now = new Date();
  const locked = !!x && x.status !== 'SUBMITTED';
  res.json({
    id: String(e._id),
    title: e.title,
    subject: e.subject,
    date: e.date,
    start: e.start,
    duration: e.duration,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    uploadTill: uploadDeadline(e),
    total: examTotal(e),
    instructions: e.instructions,
    status: appExamStatus(st),
    paperOpen: st !== 'SCHEDULED',
    questions: st !== 'SCHEDULED' ? e.questions.map((q) => ({ id: String(q._id), section: q.section, text: q.text, marks: q.marks, image: q.image })) : [],
    submission: sheetView(x),
    canUpload: st !== 'SCHEDULED' && st !== 'PUBLISHED' && now <= uploadDeadline(e) && !locked,
    canHandIn: st !== 'SCHEDULED' && st !== 'PUBLISHED' && !locked,
    serverTime: now,
  });
});

const submitBody = z.discriminatedUnion('mode', [
  /** Photos of the notebook, made into one PDF in the app and uploaded first (POST /student/uploads/answer). */
  z.object({ mode: z.literal('UPLOAD'), file: z.string().regex(/^\/files\/[a-f0-9]{32}\.pdf$/, 'Upload the PDF first'), pages: z.number().int().min(1).max(200).optional() }),
  /** The notebook was handed in at the centre. */
  z.object({ mode: z.literal('MANUAL') }),
]);

/** Hand in the answer sheet (or replace it before the teacher checks it). */
studentTestsRouter.post('/exams/:id/submission', async (req, res) => {
  const e = await myExam(req);
  const body = parse(submitBody, req.body);
  const s = studentOf(req);
  const st = examStatus(e);
  const now = new Date();
  if (st === 'SCHEDULED') throw unprocessable('NOT_STARTED', 'This exam has not started yet');
  if (st === 'PUBLISHED') throw unprocessable('CLOSED', 'Results are already published');
  if (body.mode === 'UPLOAD' && now > uploadDeadline(e)) throw unprocessable('UPLOAD_CLOSED', 'The time to upload answers is over — hand in your notebook at the centre');
  let x = await ExamSubmission.findOne({ exam: e._id, student: s._id });
  if (x && x.status !== 'SUBMITTED') throw conflict(x.status === 'CHECKED' ? 'Your answers are already checked' : 'You were marked absent — talk to the office');
  if (!x) x = new ExamSubmission({ exam: e._id, student: s._id, mode: body.mode, by: 'STUDENT' });
  x.mode = body.mode;
  x.by = 'STUDENT';
  x.submittedAt = now;
  x.late = now > e.endsAt;
  if (body.mode === 'UPLOAD') {
    x.file = body.file;
    x.pages = body.pages;
  } else {
    x.file = undefined;
    x.pages = undefined;
  }
  await x.save();
  res.status(201).json(sheetView(x.toObject()));
});

/** Marks per question, total, rank and grade once the admin publishes results (the exam report card). */
studentTestsRouter.get('/exams/:id/result', async (req, res) => {
  const e = await myExam(req);
  if (!e.resultsPublished) throw unprocessable('NOT_PUBLISHED', 'Results are not published yet');
  const s = studentOf(req);
  const cat = await loadCatalog();
  const { ranked, total } = await examResults(e, (x) => subjectNames(cat, x));
  const me = ranked.find((r) => r.student === String(s._id));
  const x = await ExamSubmission.findOne({ exam: e._id, student: s._id }).lean();
  const marks = marksObj(x?.marks);
  const percent = me && total ? Math.round((me.score / total) * 1000) / 10 : undefined;
  res.json({
    exam: { id: String(e._id), title: e.title, subject: e.subject, date: e.date, total },
    attended: !!me,
    absent: !me,
    score: me?.score,
    percent,
    grade: percent !== undefined ? grade(percent) : undefined,
    rank: me?.rank,
    of: ranked.length,
    topper: ranked[0]?.score ?? 0,
    average: ranked.length ? Math.round((ranked.reduce((a, r) => a + r.score, 0) / ranked.length) * 10) / 10 : 0,
    remarks: x?.remarks ?? '',
    mode: x?.mode,
    questions: e.questions.map((q, i) => ({ no: i + 1, section: q.section, text: q.text, marks: q.marks, got: marks?.[String(q._id)] })),
  });
});

/* ───────────────────────── Mock tests ───────────────────────── */

async function myMock(req: Request) {
  const id = parse(zId, req.params.id);
  const s = studentOf(req);
  const m = await MockTest.findOne({ _id: id, published: true });
  if (!m || !testIsFor(m, s, await mySubjects(s))) throw notFound('Mock test');
  return m;
}

studentTestsRouter.get('/mocks/:id', async (req, res) => {
  const m = await myMock(req);
  const s = studentOf(req);
  const attempts = await Attempt.find({ kind: 'MOCK', test: m._id, student: s._id }, { answers: 0 }).sort({ attemptNo: 1 }).lean();
  const board = await mockBoard(m);
  const me = board.find((r) => r.student === String(s._id));
  res.json({
    id: String(m._id),
    title: m.title,
    subject: m.subject,
    duration: m.duration,
    questions: m.questions.length,
    marksPerQ: m.marksPerQ,
    negative: m.negative,
    total: totalMarks(m),
    instructions: m.instructions,
    openFrom: m.openFrom,
    openTill: m.openTill,
    attemptsAllowed: m.attemptsAllowed,
    showAnswers: m.showAnswers,
    status: mockStatus(m, todayIST()),
    attempts: attempts.map((a) => ({ id: String(a._id), attemptNo: a.attemptNo, status: a.status, score: a.score, timeSec: a.timeSec, submittedAt: a.submittedAt, deadline: a.deadline })),
    rank: me?.rank,
    of: board.length,
    serverTime: new Date(),
  });
});

studentTestsRouter.post('/mocks/:id/start', async (req, res) => {
  const m = await myMock(req);
  const a = await startAttempt('MOCK', m, studentOf(req)._id);
  res.status(201).json({ attempt: { id: String(a._id), attemptNo: a.attemptNo, deadline: a.deadline, startedAt: a.startedAt, answers: Object.fromEntries(a.answers) }, questions: publicQuestions(m.questions), serverTime: new Date() });
});

/* ───────────────────────── Attempts (both kinds) ───────────────────────── */

async function myAttempt(req: Request) {
  const id = parse(zId, req.params.id);
  const a = await Attempt.findOne({ _id: id, student: studentOf(req)._id });
  if (!a) throw notFound('Attempt');
  // Online attempts are mock tests only (old online exams are written exams now).
  const test = a.kind === 'MOCK' ? await MockTest.findById(a.test) : null;
  if (!test) throw notFound('Test');
  return { a, test };
}

const answersBody = z.object({
  answers: z.record(z.string().max(40), z.number().int().min(0).max(3).nullable()).default({}),
  appSwitches: z.number().int().min(0).max(10_000).optional(),
});

/** Autosave while answering. */
studentTestsRouter.put('/attempts/:id/answers', async (req, res) => {
  const body = parse(answersBody, req.body);
  const { a, test } = await myAttempt(req);
  await saveAnswers(a, test, body.answers, body.appSwitches);
  res.json({ saved: a.answers.size, deadline: a.deadline, serverTime: new Date() });
});

studentTestsRouter.post('/attempts/:id/submit', async (req, res) => {
  const body = parse(answersBody, req.body ?? {});
  const { a, test } = await myAttempt(req);
  if (a.status === 'IN_PROGRESS' && Object.keys(body.answers).length) {
    // Late final answers are dropped; whatever was saved in time still counts.
    await saveAnswers(a, test, body.answers, body.appSwitches).catch((e: { code?: string }) => {
      if (e.code !== 'TIME_UP') throw e;
    });
  }
  await finalize(a, test);
  const showKey = (test as { showAnswers?: boolean }).showAnswers !== false;
  res.json({ kind: 'MOCK', ...attemptReview(test, a, showKey) });
});

/** A finished mock attempt (with the answer key when the mock allows it). */
studentTestsRouter.get('/attempts/:id', async (req, res) => {
  const { a, test } = await myAttempt(req);
  if (a.status !== 'SUBMITTED') {
    return res.json({ id: String(a._id), kind: a.kind, status: a.status, deadline: a.deadline, answers: Object.fromEntries(a.answers), questions: publicQuestions(test.questions), serverTime: new Date() });
  }
  const withKey = test.showAnswers !== false;
  res.json({ kind: a.kind, ...attemptReview(test, a, withKey) });
});
