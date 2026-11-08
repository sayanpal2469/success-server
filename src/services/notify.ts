import type { QueryFilter, Types } from 'mongoose';

import { logger } from '../lib/logger.js';
import { ALL_SUBJECTS, ClassDef } from '../models/catalog.js';
import { Notification, type NOTIFICATION_TYPES } from '../models/notifications.js';
import { Student, type StudentDoc } from '../models/students.js';

export type NotificationInput = { type: (typeof NOTIFICATION_TYPES)[number]; title: string; body?: string; href?: string };

/**
 * In-app notifications. Sending never fails the action that caused it (a notice is still saved
 * even if the notifications can't be written) — errors are only logged.
 */
async function insert(rows: Record<string, unknown>[]) {
  if (!rows.length) return 0;
  try {
    await Notification.insertMany(rows, { ordered: false });
    return rows.length;
  } catch (err) {
    logger.error({ err }, 'could not save notifications');
    return 0;
  }
}

/** One notification to every active student matching `filter`. */
export async function notifyStudents(filter: QueryFilter<StudentDoc>, n: NotificationInput) {
  const ids = await Student.find({ ...filter, status: 'ACTIVE' }, { _id: 1 }).lean();
  return insert(ids.map((s) => ({ student: s._id, ...n })));
}

/** A notification to one student. */
export const notifyStudent = (student: Types.ObjectId | string, n: NotificationInput) => insert([{ student, ...n }]);

/** Different text per student (e.g. their own marks). */
export const notifyEach = (rows: { student: Types.ObjectId | string; n: NotificationInput }[]) => insert(rows.map((r) => ({ student: r.student, ...r.n })));

/** Students of a class or an extra curriculum (routine groups and class notices use either id). */
export const groupFilter = (groupId: string): QueryFilter<StudentDoc> => ({ $or: [{ classId: groupId }, { extras: groupId }] });

/** Students an exam / mock is for: the class, and the subject unless it is a mixed test. */
export async function testFilter(classId: string, subject: string): Promise<QueryFilter<StudentDoc>> {
  if (subject === ALL_SUBJECTS) return { classId };
  const cls = await ClassDef.findById(classId).lean();
  const ids = (cls?.subjects ?? []).filter((s) => s.name === subject).map((s) => s._id);
  return { classId, subjectIds: { $in: ids } };
}
