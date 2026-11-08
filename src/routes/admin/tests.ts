import { Router } from 'express';
import { z } from 'zod';

import { adminOf } from '../../lib/auth.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { todayIST } from '../../lib/time.js';
import { cleanHtml } from '../../lib/html.js';
import { signFileUrl } from '../../lib/files.js';
import { parse, zCode, zDate, zId, zPatch, zQuestion, zText, zTime, zUrl } from '../../lib/validate.js';
import { ALL_SUBJECTS, ClassDef } from '../../models/catalog.js';
import { Notice } from '../../models/content.js';
import { Student } from '../../models/students.js';
import { Attempt, Exam, ExamSubmission, examStatus, MockTest, mockStatus, uploadDeadline } from '../../models/tests.js';
import { loadCatalog, subjectNames } from '../../services/catalog.js';
import { nextDayWindow } from '../../services/notices.js';
import { examResults, examTotal, marksObj, mockBoard, testIsFor, totalMarks } from '../../services/tests.js';
import { notifyEach, notifyStudents, testFilter } from '../../services/notify.js';

export const testsRouter = Router();

const common = {
  title: z.string().trim().min(1).max(160),
  classId: zCode,
  subject: z.string().trim().min(1).max(80),
  duration: z.number().int().min(10, 'At least 10 minutes').max(360, 'At most 6 hours'),
  instructions: zText(5000).default(''),
};

/** The subject must be one the class offers (by name), or "All subjects" for a mixed test. */
async function checkClassSubject(classId: string, subject: string) {
  const c = await ClassDef.findById(classId).lean();
  if (!c) throw badRequest('Unknown class', { field: 'classId' });
  if (subject !== ALL_SUBJECTS && !c.subjects.some((s) => s.name === subject)) throw badRequest(`${c.name} has no subject "${subject}"`, { field: 'subject' });
}

const stats = (scores: number[], total: number) => {
  if (!scores.length) return { highest: 0, lowest: 0, average: 0, spread: [] as { band: string; count: number }[] };
  const bands = [0, 20, 40, 60, 80].map((lo) => ({ band: `${lo}–${lo + 20}%`, count: 0 }));
  scores.forEach((s) => (bands[Math.min(4, Math.max(0, Math.floor(((total ? s / total : 0) * 100) / 20)))]!.count += 1));
  return { highest: Math.max(...scores), lowest: Math.min(...scores), average: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10, spread: bands };
};

/* ───────────────────────── Written exams ───────────────────────── */

const zWrittenQuestion = z.object({
  id: zId.optional(),
  section: zText(120).default(''),
  text: z.string().trim().min(1, 'Question text is required').max(20_000),
  marks: z.number().min(0).max(1000),
  image: zUrl.optional(),
});
const examBody = z.object({
  ...common,
  date: zDate,
  start: zTime,
  questions: z.array(zWrittenQuestion).max(200).default([]),
  uploadMinutes: z.number().int().min(0).max(10_080).default(120),
});
const toQuestions = (qs: z.infer<typeof zWrittenQuestion>[]) => qs.map(({ id, image, ...q }) => ({ ...q, text: cleanHtml(q.text), image: image || undefined, ...(id ? { _id: id } : {}) }));

const sheetCounts = async (ids: unknown[]) => {
  const rows = await ExamSubmission.aggregate<{ _id: { exam: unknown; mode: string; status: string }; n: number }>([
    { $match: { exam: { $in: ids } } },
    { $group: { _id: { exam: '$exam', mode: '$mode', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const out = new Map<string, { uploaded: number; manual: number; checked: number; absent: number }>();
  for (const r of rows) {
    const k = String(r._id.exam);
    const c = out.get(k) ?? { uploaded: 0, manual: 0, checked: 0, absent: 0 };
    if (r._id.status === 'ABSENT') c.absent += r.n;
    else {
      if (r._id.mode === 'UPLOAD') c.uploaded += r.n;
      else c.manual += r.n;
      if (r._id.status === 'CHECKED') c.checked += r.n;
    }
    out.set(k, c);
  }
  return out;
};

testsRouter.get('/exams', async (req, res) => {
  const q = parse(z.object({ classId: zCode.optional(), status: z.enum(['SCHEDULED', 'LIVE', 'ENDED', 'PUBLISHED']).optional() }), req.query);
  const rows = await Exam.aggregate([{ $match: q.classId ? { classId: q.classId } : {} }, { $addFields: { count: { $size: '$questions' } } }, { $project: { questions: 0 } }, { $sort: { startsAt: -1 } }]);
  const counts = await sheetCounts(rows.map((r) => r._id));
  const now = new Date();
  res.json(
    rows
      .map(({ _id, __v: _v, count, ...e }) => ({ id: String(_id), ...e, questions: count, total: e.fullMarks, status: examStatus(e, now), sheets: counts.get(String(_id)) ?? { uploaded: 0, manual: 0, checked: 0, absent: 0 } }))
      .filter((e) => !q.status || e.status === q.status),
  );
});

testsRouter.post('/exams', async (req, res) => {
  const body = parse(examBody, req.body);
  await checkClassSubject(body.classId, body.subject);
  if (!body.questions.length) throw badRequest('Add at least one question', { field: 'questions' });
  const e = await Exam.create({ ...body, questions: toQuestions(body.questions) });
  await notifyStudents(await testFilter(e.classId, e.subject), { type: 'test', title: `New exam · ${e.title}`, body: `${e.subject} · ${e.date} at ${e.start} · ${e.fullMarks} marks. The question paper opens in the app at the start time.`, href: `/exam/${String(e._id)}` });
  res.status(201).json(e);
});

async function findExam(id: unknown) {
  const e = await Exam.findById(parse(zId, id));
  if (!e) throw notFound('Exam');
  return e;
}

testsRouter.get('/exams/:id', async (req, res) => {
  const e = await findExam(req.params.id);
  res.json({ ...e.toJSON(), status: examStatus(e), total: examTotal(e), uploadTill: uploadDeadline(e) });
});

/** The paper (questions, marks, schedule) can change until the exam starts; after that only title, instructions and the upload window. */
testsRouter.patch('/exams/:id', async (req, res) => {
  const e = await findExam(req.params.id);
  const body = parse(zPatch(examBody), req.body);
  const st = examStatus(e);
  const locked = (['classId', 'subject', 'date', 'start', 'duration', 'questions'] as const).filter((k) => body[k] !== undefined);
  if (st !== 'SCHEDULED' && locked.length) throw unprocessable('EXAM_STARTED', `The exam has started — ${locked.join(', ')} can no longer change`);
  if (body.classId || body.subject) await checkClassSubject(body.classId ?? e.classId, body.subject ?? e.subject);
  if (body.questions && !body.questions.length) throw badRequest('Add at least one question', { field: 'questions' });
  const { questions, ...rest } = body;
  e.set(rest);
  if (questions) e.set('questions', toQuestions(questions));
  await e.save();
  res.json({ ...e.toJSON(), status: examStatus(e), total: examTotal(e) });
});

testsRouter.delete('/exams/:id', async (req, res) => {
  const e = await findExam(req.params.id);
  if (await ExamSubmission.exists({ exam: e._id })) throw conflict('Answer sheets or marks exist for this exam — it cannot be deleted');
  await e.deleteOne();
  res.status(204).end();
});

/**
 * Marks sheet: every student the exam is for, with how they submitted (uploaded PDF / notebook
 * handed in / nothing), a signed link to the PDF, and the marks entered so far.
 */
testsRouter.get('/exams/:id/sheets', async (req, res) => {
  const e = await findExam(req.params.id);
  const cat = await loadCatalog();
  const pool = (await Student.find({ classId: e.classId }, { name: 1, studentId: 1, batch: 1, photo: 1, classId: 1, subjectIds: 1, status: 1, roll: 1 }).lean()).filter((s) =>
    testIsFor(e, s, subjectNames(cat, s)),
  );
  const subs = await ExamSubmission.find({ exam: e._id }).lean();
  const by = new Map(subs.map((x) => [String(x.student), x]));
  // Students who left the class but already have a sheet stay on the list.
  const missing = subs.filter((x) => !pool.some((s) => String(s._id) === String(x.student))).map((x) => x.student);
  const extra = missing.length ? await Student.find({ _id: { $in: missing } }, { name: 1, studentId: 1, batch: 1, photo: 1, classId: 1, subjectIds: 1, status: 1, roll: 1 }).lean() : [];
  const rows = [...pool.filter((s) => s.status === 'ACTIVE' || by.has(String(s._id))), ...extra].map((s) => {
    const x = by.get(String(s._id));
    return {
      studentId: String(s._id),
      name: s.name,
      studentCode: s.studentId,
      roll: s.roll ?? '',
      batch: s.batch,
      photo: s.photo,
      sheet: x
        ? {
            id: String(x._id),
            mode: x.mode,
            by: x.by,
            file: signFileUrl(x.file, 240),
            pages: x.pages,
            submittedAt: x.submittedAt,
            late: x.late,
            status: x.status,
            marks: marksObj(x.marks),
            total: x.total,
            remarks: x.remarks,
            checkedAt: x.checkedAt,
            checkedBy: x.checkedBy,
          }
        : null,
    };
  });
  res.json({
    exam: { ...e.toJSON(), status: examStatus(e), total: examTotal(e), uploadTill: uploadDeadline(e) },
    rows: rows.sort((a, b) => (Number(a.roll) || 9999) - (Number(b.roll) || 9999) || a.name.localeCompare(b.name)),
  });
});

const marksBody = z.object({
  /** Marks per question (question id → marks). The total is their sum. */
  marks: z.record(zId, z.number().min(0).max(1000)).optional(),
  /** Total only, when marks aren't entered question by question. */
  total: z.number().min(0).max(100_000).optional(),
  absent: z.boolean().optional(),
  remarks: zText(1000).optional(),
});

/** Enter (or correct) one student's marks. A student with no sheet yet gets one as "notebook handed in". */
testsRouter.put('/exams/:id/marks/:studentId', async (req, res) => {
  const e = await findExam(req.params.id);
  const studentId = parse(zId, req.params.studentId);
  const body = parse(marksBody, req.body);
  if (examStatus(e) === 'SCHEDULED') throw unprocessable('NOT_STARTED', 'Marks can be entered after the exam starts');
  const s = await Student.findById(studentId, { classId: 1, subjectIds: 1 }).lean();
  if (!s) throw notFound('Student');
  const cat = await loadCatalog();
  if (!testIsFor(e, s, subjectNames(cat, s)) && !(await ExamSubmission.exists({ exam: e._id, student: studentId }))) throw badRequest('This exam is not for this student');

  let x = await ExamSubmission.findOne({ exam: e._id, student: studentId });
  if (!x) x = new ExamSubmission({ exam: e._id, student: studentId, mode: 'MANUAL', by: 'OFFICE', submittedAt: new Date() });
  if (body.remarks !== undefined) x.remarks = body.remarks;

  if (body.absent) {
    if (x.mode === 'UPLOAD' && x.file) throw conflict('This student uploaded an answer sheet — enter marks instead of marking absent');
    x.status = 'ABSENT';
    x.marks = undefined;
    x.total = undefined;
  } else if (body.marks || body.total !== undefined) {
    const full = examTotal(e);
    let total = body.total;
    if (body.marks) {
      const qs = new Map(e.questions.map((q) => [String(q._id), q]));
      for (const [qid, m] of Object.entries(body.marks)) {
        const q = qs.get(qid);
        if (!q) throw badRequest('Unknown question in marks', { field: 'marks' });
        if (m > q.marks) throw badRequest(`Question ${e.questions.indexOf(q) + 1} is out of ${q.marks}`, { field: 'marks' });
      }
      x.marks = new Map(Object.entries(body.marks));
      total = Object.values(body.marks).reduce((a, b) => a + b, 0);
    } else x.marks = undefined;
    if (total! > full) throw badRequest(`Total can't be more than the full marks (${full})`, { field: 'total' });
    x.total = Math.round(total! * 100) / 100;
    x.status = 'CHECKED';
    x.checkedAt = new Date();
    x.checkedBy = adminOf(req).name;
  } else if (body.absent === false && x.status === 'ABSENT') {
    x.status = 'SUBMITTED';
  }
  await x.save();
  res.json({ id: String(x._id), mode: x.mode, by: x.by, status: x.status, marks: x.marks ? Object.fromEntries(x.marks) : undefined, total: x.total, remarks: x.remarks, checkedAt: x.checkedAt, checkedBy: x.checkedBy });
});

/** Clears a student's marks / absent mark (an office-made sheet with nothing on it is removed). */
testsRouter.delete('/exams/:id/marks/:studentId', async (req, res) => {
  const e = await findExam(req.params.id);
  const x = await ExamSubmission.findOne({ exam: e._id, student: parse(zId, req.params.studentId) });
  if (!x) throw notFound('Marks');
  if (x.by === 'OFFICE' && !x.file) await x.deleteOne();
  else {
    x.status = 'SUBMITTED';
    x.marks = undefined;
    x.total = undefined;
    x.checkedAt = undefined;
    x.checkedBy = undefined;
    await x.save();
  }
  res.status(204).end();
});

/** Ranking, absent list and marks spread. */
testsRouter.get('/exams/:id/results', async (req, res) => {
  const e = await findExam(req.params.id);
  const cat = await loadCatalog();
  const { ranked, absent, pending, total } = await examResults(e, (s) => subjectNames(cat, s));
  const students = await Student.find({ _id: { $in: ranked.map((r) => r.student) } }, { name: 1, studentId: 1, batch: 1, photo: 1 }).lean();
  const who = new Map(students.map((s) => [String(s._id), s]));
  res.json({
    exam: { id: String(e._id), title: e.title, classId: e.classId, subject: e.subject, date: e.date, total, status: examStatus(e), publishedAt: e.publishedAt },
    stats: { attended: ranked.length, absent: absent.length, pending: pending.length, ...stats(ranked.map((r) => r.score), total) },
    ranking: ranked.map((r) => {
      const s = who.get(r.student);
      return { ...r, name: s?.name, studentCode: s?.studentId, batch: s?.batch, photo: s?.photo, percent: total ? Math.round((r.score / total) * 1000) / 10 : 0 };
    }),
    absent: absent.map((s) => ({ id: String(s._id), name: s.name, studentCode: s.studentId, batch: s.batch })),
    pending: pending.map((s) => ({ id: String(s._id), name: s.name, studentCode: s.studentId, batch: s.batch })),
  });
});

/**
 * Publish: students see their marks and exam report card, results join the performance tracker and
 * the annual report card, and the topper goes on the notice board the next day for one day.
 */
testsRouter.post('/exams/:id/publish', async (req, res) => {
  const e = await findExam(req.params.id);
  const st = examStatus(e);
  if (st === 'PUBLISHED') throw conflict('Results are already published');
  if (st !== 'ENDED') throw unprocessable('EXAM_NOT_ENDED', 'Results can be published after the exam ends');
  const cat = await loadCatalog();
  const { ranked, total } = await examResults(e, (s) => subjectNames(cat, s));
  if (!ranked.length) throw unprocessable('NO_MARKS', 'Enter marks for at least one student before publishing');
  const toppers = ranked.filter((r) => r.rank === 1);
  let notice;
  if (toppers.length) {
    const people = await Student.find({ _id: { $in: toppers.map((t) => t.student) } }, { name: 1, photo: 1 }).lean();
    const names = people.map((p) => p.name).join(' & ');
    const className = cat.classes.get(e.classId)?.name ?? e.classId;
    notice = await Notice.create({
      title: `🏆 Topper — ${e.title} (${className})`,
      body: `<p>Congratulations <b>${names}</b> for scoring <b>${toppers[0]!.score} / ${total}</b> and coming first in ${e.title}!</p>`,
      image: people.length === 1 ? people[0]!.photo : undefined,
      audience: 'All students',
      kind: 'TOPPER',
      pinned: true,
      showOnWebsite: true,
      by: adminOf(req).name,
      ...nextDayWindow(),
    });
  }
  e.resultsPublished = true;
  e.publishedAt = new Date();
  if (notice) e.topperNotice = notice._id;
  await e.save();
  // Each student gets their own marks; everyone else the exam is for gets "result published".
  const sat = new Map(ranked.map((r) => [r.student, r]));
  const pool = await Student.find(await testFilter(e.classId, e.subject), { _id: 1, status: 1 }).lean();
  await notifyEach(
    pool
      .filter((s) => s.status === 'ACTIVE' || sat.has(String(s._id)))
      .map((s) => {
        const r = sat.get(String(s._id));
        return {
          student: s._id,
          n: { type: 'result' as const, title: `Result published · ${e.title}`, body: r ? `You scored ${r.score} / ${total} · rank ${r.rank} of ${ranked.length}.` : 'You were absent for this exam.', href: `/exam/${String(e._id)}` },
        };
      }),
  );
  res.json({ ...e.toJSON(), status: examStatus(e), total, topperNotice: notice });
});

/* ───────────────────────── Mock tests ───────────────────────── */

const mockBody = z.object({
  ...common,
  marksPerQ: z.number().min(0).max(100),
  negative: z.number().min(0).max(100).default(0),
  questions: z.array(zQuestion).max(500).default([]),
  sourceFile: zText(200).optional(),
  openFrom: zDate,
  openTill: z.union([zDate, z.literal('')]).optional(),
  attemptsAllowed: z.number().int().min(0).max(50).default(1),
  showAnswers: z.boolean().default(true),
  published: z.boolean().default(false),
});

testsRouter.get('/mocks', async (req, res) => {
  const q = parse(z.object({ classId: zCode.optional() }), req.query);
  const rows = await MockTest.aggregate([{ $match: q.classId ? { classId: q.classId } : {} }, { $addFields: { count: { $size: '$questions' } } }, { $project: { questions: 0 } }, { $sort: { openFrom: -1 } }]);
  const tried = await Attempt.aggregate<{ _id: unknown; n: number; students: unknown[] }>([
    { $match: { kind: 'MOCK', test: { $in: rows.map((r) => r._id) }, status: 'SUBMITTED' } },
    { $group: { _id: '$test', n: { $sum: 1 }, students: { $addToSet: '$student' } } },
  ]);
  const t = new Map(tried.map((x) => [String(x._id), x]));
  const today = todayIST();
  res.json(
    rows.map(({ _id, __v: _v, count, ...m }) => ({
      id: String(_id),
      ...m,
      questions: count,
      total: count * m.marksPerQ,
      status: mockStatus(m, today),
      attempts: t.get(String(_id))?.n ?? 0,
      students: t.get(String(_id))?.students.length ?? 0,
    })),
  );
});

testsRouter.post('/mocks', async (req, res) => {
  const body = parse(mockBody, req.body);
  await checkClassSubject(body.classId, body.subject);
  if (body.openTill && body.openTill < body.openFrom) throw badRequest('Open till must be after open from', { field: 'openTill' });
  if (body.published && !body.questions.length) throw badRequest('Add questions before publishing', { field: 'questions' });
  res.status(201).json(await MockTest.create({ ...body, openTill: body.openTill || undefined }));
});

async function findMock(id: unknown) {
  const m = await MockTest.findById(parse(zId, id));
  if (!m) throw notFound('Mock test');
  return m;
}

testsRouter.get('/mocks/:id', async (req, res) => {
  const m = await findMock(req.params.id);
  res.json({ ...m.toJSON(), status: mockStatus(m, todayIST()), total: totalMarks(m), attempts: await Attempt.countDocuments({ kind: 'MOCK', test: m._id }) });
});

/** Questions stay editable until the first attempt; settings (hide, dates, attempts) any time. */
testsRouter.patch('/mocks/:id', async (req, res) => {
  const m = await findMock(req.params.id);
  const body = parse(zPatch(mockBody), req.body);
  const scoring = (['questions', 'marksPerQ', 'negative', 'classId', 'subject'] as const).filter((k) => body[k] !== undefined);
  if (scoring.length && (await Attempt.exists({ kind: 'MOCK', test: m._id }))) throw unprocessable('MOCK_ATTEMPTED', `Students have attempted it — ${scoring.join(', ')} can no longer change`);
  if (body.classId || body.subject) await checkClassSubject(body.classId ?? m.classId, body.subject ?? m.subject);
  const { openTill, ...rest } = body;
  m.set(rest);
  if (openTill !== undefined) m.openTill = openTill || undefined;
  if (m.openTill && m.openTill < m.openFrom) throw badRequest('Open till must be after open from', { field: 'openTill' });
  if (m.published && !m.questions.length) throw badRequest('Add questions before publishing', { field: 'questions' });
  await m.save();
  res.json({ ...m.toJSON(), status: mockStatus(m, todayIST()) });
});

testsRouter.delete('/mocks/:id', async (req, res) => {
  const m = await findMock(req.params.id);
  if (await Attempt.exists({ kind: 'MOCK', test: m._id })) throw conflict('Students have attempted it — hide it (unpublish) instead');
  await m.deleteOne();
  res.status(204).end();
});

/** Tried / not tried, best and last score, ranking. */
testsRouter.get('/mocks/:id/board', async (req, res) => {
  const m = await findMock(req.params.id);
  const cat = await loadCatalog();
  const board = await mockBoard(m);
  const pool = (await Student.find({ classId: m.classId, status: 'ACTIVE' }, { name: 1, studentId: 1, batch: 1, classId: 1, subjectIds: 1, photo: 1 }).lean()).filter((s) =>
    testIsFor(m, s, subjectNames(cat, s)),
  );
  const who = new Map(pool.map((s) => [String(s._id), s]));
  const extra = await Student.find({ _id: { $in: board.map((b) => b.student).filter((id) => !who.has(id)) } }, { name: 1, studentId: 1, batch: 1 }).lean();
  extra.forEach((s) => who.set(String(s._id), s as (typeof pool)[number]));
  const tried = new Set(board.map((b) => b.student));
  const total = totalMarks(m);
  res.json({
    mock: { id: String(m._id), title: m.title, total, status: mockStatus(m, todayIST()) },
    stats: { tried: board.length, notTried: pool.filter((s) => !tried.has(String(s._id))).length, ...stats(board.map((b) => b.best), total) },
    ranking: board.map((b) => ({ ...b, name: who.get(b.student)?.name, studentCode: who.get(b.student)?.studentId, batch: who.get(b.student)?.batch })),
    notTried: pool.filter((s) => !tried.has(String(s._id))).map((s) => ({ id: String(s._id), name: s.name, studentCode: s.studentId, batch: s.batch })),
  });
});
