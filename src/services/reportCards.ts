import type { Types } from 'mongoose';

import { sessionOf, sessionRange, todayIST } from '../lib/time.js';
import { getSettings } from '../models/org.js';
import { Student, type StudentDoc } from '../models/students.js';
import { groupName, loadCatalog } from './catalog.js';
import { performanceOf } from './performance.js';
import { grade, rank } from './tests.js';

/**
 * Annual report card: every written exam of the session whose results are published (mock tests
 * are not included — they have their own results), averaged per subject, plus attendance, the
 * latest teacher remark and the class rank. Built automatically from the exam marks.
 */
export async function reportCards(q: { studentId?: string | Types.ObjectId; classId?: string; session?: string }) {
  const session = q.session ?? sessionOf(todayIST());
  const range = sessionRange(session);
  const [cat, settings] = await Promise.all([loadCatalog(), getSettings()]);
  const one = q.studentId ? await Student.findById(q.studentId).lean() : null;
  const classId = one?.classId ?? q.classId!;
  const classmates = await Student.find({ classId, status: 'ACTIVE' }).lean();
  const all = one && !classmates.some((s) => String(s._id) === String(one._id)) ? [...classmates, one] : classmates;

  const cards = await Promise.all(
    all.map(async (s) => {
      const p = await performanceOf(s as StudentDoc, cat, range);
      const bySubject = new Map<string, { score: number; total: number; pcts: number[] }>();
      p.exams
        .filter((e) => e.attended)
        .forEach((e) => {
          const cur = bySubject.get(e.subject) ?? { score: 0, total: 0, pcts: [] };
          cur.score += e.score ?? 0;
          cur.total += e.total;
          cur.pcts.push(e.percent ?? 0);
          bySubject.set(e.subject, cur);
        });
      const subjects = [...bySubject.entries()].map(([subject, v]) => {
        const avg = Math.round((v.pcts.reduce((a, b) => a + b, 0) / v.pcts.length) * 10) / 10;
        return { subject, exams: v.pcts.length, score: Math.round(v.score * 100) / 100, total: v.total, average: avg, grade: grade(avg) };
      });
      return {
        student: { id: String(s._id), studentId: s.studentId, name: s.name, photo: s.photo, className: groupName(cat, s.classId), batch: s.batch, roll: s.roll ?? '', fatherName: s.fatherName, motherName: s.motherName, dob: s.dob, school: s.school, board: s.board },
        exams: p.exams.map((e) => ({ id: e.examId, title: e.title, subject: e.subject, date: e.date, total: e.total, attended: e.attended, score: e.score, percent: e.percent, grade: e.percent !== undefined ? grade(e.percent) : undefined, rank: e.rank, of: e.of })),
        subjects,
        overall: p.examAverage,
        overallGrade: p.examAverage === null ? null : grade(p.examAverage),
        attendance: { held: p.attendance.held, present: p.attendance.present, percent: p.attendance.percent },
        examAttendance: p.examAttendance,
        remarks: p.feedback[0]?.text ?? '',
        timeSec: 0,
        score: p.examAverage ?? -1,
      };
    }),
  );
  const ranked = rank(cards.filter((c) => c.overall !== null));
  const rankOf = new Map(ranked.map((c) => [c.student.id, c.rank]));
  const out = cards
    .filter((c) => !one || c.student.id === String(one._id))
    .map(({ timeSec: _t, score: _s, ...c }) => ({ ...c, classRank: rankOf.get(c.student.id) ?? null, classSize: ranked.length }));
  const contact = settings.contact;
  return {
    session,
    institute: { name: settings.instituteName, centerHead: settings.centerHead, signature: settings.signature, address: contact?.address, phone: contact?.phone, email: contact?.email },
    cards: out,
  };
}
