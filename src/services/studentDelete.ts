import type { Types } from 'mongoose';

import { revokeAllFor } from '../lib/auth.js';
import { removeStoredFile } from '../lib/files.js';
import { LessonProgress } from '../models/content.js';
import { Notification } from '../models/notifications.js';
import { Session } from '../models/org.js';
import { Attendance, CheckIn } from '../models/schedule.js';
import { Application, Feedback, FeeReminder, Payment, Student } from '../models/students.js';
import { Attempt, ExamSubmission } from '../models/tests.js';

/**
 * Deleting students. Soft delete hides them everywhere (see the query hook on the Student model)
 * and keeps all their records, so they can be restored. Hard delete removes the student and every
 * record about them — payments, attendance marks, check-ins, exam sheets, mock attempts, feedback,
 * reminders, notifications, course progress, the admission request and uploaded files.
 */

type Id = Types.ObjectId | string;

/** What each student is linked to, for the "this student is used in …" warning. Counts > 0 only. */
export async function studentLinks(ids: Id[]) {
  const students = await Student.find({ _id: { $in: ids } }, { name: 1, studentId: 1, deletedAt: 1 })
    .setOptions({ withDeleted: true })
    .lean();
  return Promise.all(
    students.map(async (s) => {
      const student = s._id;
      const [payments, attendance, checkIns, examSheets, mockAttempts, feedback, reminders, notifications, lessons] = await Promise.all([
        Payment.countDocuments({ student }),
        Attendance.countDocuments({ 'marks.student': student }),
        CheckIn.countDocuments({ student }),
        ExamSubmission.countDocuments({ student }),
        Attempt.countDocuments({ student }),
        Feedback.countDocuments({ student }),
        FeeReminder.countDocuments({ student }),
        Notification.countDocuments({ student }),
        LessonProgress.countDocuments({ student }),
      ]);
      const links = { payments, attendance, checkIns, examSheets, mockAttempts, feedback, reminders, notifications, lessons };
      return {
        id: String(student),
        name: s.name,
        studentId: s.studentId,
        deleted: !!s.deletedAt,
        links: Object.fromEntries(Object.entries(links).filter(([, n]) => n > 0)) as Partial<typeof links>,
      };
    }),
  );
}

export async function softDeleteStudents(ids: Id[], by: string) {
  const r = await Student.updateMany({ _id: { $in: ids } }, { $set: { deletedAt: new Date(), deletedBy: by } });
  // Signed-in app sessions end straight away.
  await Promise.all(ids.map((id) => revokeAllFor(id)));
  return r.modifiedCount;
}

export async function restoreStudents(ids: Id[]) {
  const r = await Student.updateMany({ _id: { $in: ids }, deletedAt: { $ne: null } }, { $unset: { deletedAt: 1, deletedBy: 1 } });
  return r.modifiedCount;
}

/** Removes the students (active or soft-deleted) and everything about them. */
export async function hardDeleteStudents(ids: Id[]) {
  const students = await Student.find({ _id: { $in: ids } })
    .setOptions({ withDeleted: true })
    .lean();
  if (!students.length) return 0;
  const sid = students.map((s) => s._id);
  const [apps, checkIns, sheets] = await Promise.all([
    Application.find({ $or: [{ student: { $in: sid } }, { _id: { $in: students.map((s) => s.application).filter(Boolean) } }] }, { photo: 1, documents: 1 }).lean(),
    CheckIn.find({ student: { $in: sid } }, { photo: 1 }).lean(),
    ExamSubmission.find({ student: { $in: sid } }, { file: 1 }).lean(),
  ]);
  const docUrls = (d: unknown) => Object.values((d ?? {}) as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
  const files = new Set<string>([
    ...students.flatMap((s) => [s.photo, ...docUrls(s.documents)]),
    ...apps.flatMap((a) => [a.photo, ...docUrls(a.documents)]),
    ...checkIns.map((c) => c.photo),
    ...sheets.map((x) => x.file),
  ].filter((u): u is string => !!u));

  await Promise.all([
    Payment.deleteMany({ student: { $in: sid } }),
    Attendance.updateMany({ 'marks.student': { $in: sid } }, { $pull: { marks: { student: { $in: sid } } } }),
    CheckIn.deleteMany({ student: { $in: sid } }),
    ExamSubmission.deleteMany({ student: { $in: sid } }),
    Attempt.deleteMany({ student: { $in: sid } }),
    Feedback.deleteMany({ student: { $in: sid } }),
    FeeReminder.deleteMany({ student: { $in: sid } }),
    Notification.deleteMany({ student: { $in: sid } }),
    LessonProgress.deleteMany({ student: { $in: sid } }),
    Application.deleteMany({ _id: { $in: apps.map((a) => a._id) } }),
    Session.deleteMany({ kind: 'STUDENT', user: { $in: sid } }),
  ]);
  const r = await Student.deleteMany({ _id: { $in: sid } });
  await Promise.all([...files].map(removeStoredFile));
  return r.deletedCount;
}

/** Ids of soft-deleted students, for leaving their records out of panel-wide lists and rankings. */
export async function deletedStudentIds() {
  const rows = await Student.find({ deletedAt: { $ne: null } }, { _id: 1 }).lean();
  return new Set(rows.map((r) => String(r._id)));
}
