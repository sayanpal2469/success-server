import type { Types } from 'mongoose';

import type { CourseDoc } from '../models/content.js';

type Learner = { classId: string; extras: string[]; courseIds: Types.ObjectId[] | string[] };

/** Course access: the student's class, one of their extra curriculums, or enrolled one by one. */
export const hasAccess = (c: Pick<CourseDoc, 'access'> & { _id: Types.ObjectId }, s: Learner) =>
  (c.access?.classes ?? []).includes(s.classId) || (c.access?.extras ?? []).some((e) => s.extras.includes(e)) || s.courseIds.map(String).includes(String(c._id));

/** Filter for published courses a student can open. */
export const accessFilter = (s: Learner) => ({
  published: true,
  $or: [{ 'access.classes': s.classId }, { 'access.extras': { $in: s.extras } }, { _id: { $in: s.courseIds } }],
});

export const lessonCount = (c: Pick<CourseDoc, 'modules'>) => c.modules.reduce((a, m) => a + m.lessons.length, 0);
