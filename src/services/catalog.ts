import { ClassDef, Extra, type ClassDoc, type ExtraDoc } from '../models/catalog.js';
import { badRequest } from '../lib/errors.js';

export type Catalog = { classes: Map<string, ClassDoc>; extras: Map<string, ExtraDoc> };

/** Classes and extra curriculums are a few dozen rows — load them whole when fees or names are needed. */
export async function loadCatalog(): Promise<Catalog> {
  const [classes, extras] = await Promise.all([ClassDef.find().sort({ order: 1 }).lean(), Extra.find().sort({ order: 1 }).lean()]);
  return { classes: new Map(classes.map((c) => [c._id, c as ClassDoc])), extras: new Map(extras.map((e) => [e._id, e as ExtraDoc])) };
}

export const groupName = (cat: Catalog, id: string) => cat.classes.get(id)?.name ?? cat.extras.get(id)?.name ?? id;

/** Subject names a student takes (routine and tests match on names). */
export function subjectNames(cat: Catalog, s: { classId: string; subjectIds: string[] }) {
  return (cat.classes.get(s.classId)?.subjects ?? []).filter((x) => s.subjectIds.includes(x._id)).map((x) => x.name);
}

/**
 * Checks a class / subjects / extras / batch choice against the catalog and returns it cleaned.
 * `forApplicant` also requires the class to be open for admission.
 */
export function checkEnrolment(cat: Catalog, input: { classId: string; subjectIds: string[]; extras: string[]; batch?: string }, forApplicant = false) {
  const cls = cat.classes.get(input.classId);
  if (!cls) throw badRequest('Unknown class', { field: 'classId' });
  if (forApplicant && !cls.active) throw badRequest(`${cls.name} is not open for admission right now`, { field: 'classId' });
  const valid = new Set(cls.subjects.map((s) => s._id));
  const bad = input.subjectIds.filter((id) => !valid.has(id));
  if (bad.length) throw badRequest(`These subjects are not offered in ${cls.name}: ${bad.join(', ')}`, { field: 'subjectIds' });
  const subjectIds = [...new Set(input.subjectIds)];
  if (!subjectIds.length && !input.extras.length) throw badRequest('Choose at least one subject', { field: 'subjectIds' });
  const badExtra = input.extras.filter((id) => !cat.extras.get(id) || (forApplicant && !cat.extras.get(id)!.active));
  if (badExtra.length) throw badRequest(`Unknown extra curriculum: ${badExtra.join(', ')}`, { field: 'extras' });
  if (input.batch && cls.batches.length && !cls.batches.includes(input.batch)) throw badRequest(`${cls.name} has no batch "${input.batch}"`, { field: 'batch' });
  return { cls, subjectIds, extras: [...new Set(input.extras)] };
}
