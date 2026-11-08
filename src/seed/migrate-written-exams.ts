/**
 * npm run migrate:written-exams
 *
 * Exams used to be online MCQ tests; they are written (pen and paper) exams now. This converts
 * exams saved in the old shape — each MCQ becomes a written question worth `marksPerQ` — and turns
 * old submitted online attempts into checked answer sheets with the same score, so published
 * results and report cards keep their marks. Nothing is deleted; safe to run more than once.
 */
import mongoose from 'mongoose';

import { env } from '../config/env.js';
import { connectDb } from '../db/connect.js';
import { logger } from '../lib/logger.js';
import { Exam, ExamSubmission } from '../models/tests.js';

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

await connectDb(env.MONGODB_URI);
try {
  const exams = mongoose.connection.db!.collection('exams');
  const attempts = mongoose.connection.db!.collection('attempts');
  let converted = 0;
  let sheets = 0;
  for (const raw of await exams.find({ 'questions.0.options': { $exists: true } }).toArray()) {
    const per = Number(raw.marksPerQ ?? 1) || 1;
    const questions = (raw.questions as { _id: unknown; q: string; options: string[] }[]).map((q) => ({
      _id: q._id,
      section: '',
      text: `<p>${esc(q.q)}</p><p>${q.options.map((o, i) => `(${'abcd'[i]}) ${esc(o)}`).join('&nbsp;&nbsp; ')}</p>`,
      marks: per,
    }));
    await exams.updateOne(
      { _id: raw._id },
      { $set: { questions, fullMarks: questions.length * per, uploadMinutes: raw.uploadMinutes ?? 120 }, $unset: { marksPerQ: '', negative: '', sourceFile: '' } },
    );
    converted++;
    const done = await attempts.find({ kind: 'EXAM', test: raw._id, status: 'SUBMITTED' }).toArray();
    for (const a of done) {
      const exists = await ExamSubmission.exists({ exam: raw._id, student: a.student });
      if (exists) continue;
      await ExamSubmission.create({
        exam: raw._id,
        student: a.student,
        mode: 'MANUAL',
        by: 'STUDENT',
        submittedAt: a.submittedAt ?? a.startedAt,
        status: 'CHECKED',
        total: Math.max(0, Math.min(questions.length * per, Number(a.score ?? 0))),
        remarks: 'Online exam (before written exams)',
        checkedAt: a.submittedAt ?? new Date(),
        checkedBy: 'Online exam',
      });
      sheets++;
    }
  }
  // Exams created in the new shape before fullMarks existed.
  for (const e of await Exam.find({ $or: [{ fullMarks: { $exists: false } }, { fullMarks: 0 }] })) await e.save();
  logger.info({ converted, sheets }, 'written exams migration finished');
} finally {
  await mongoose.disconnect();
}
