import { loadCatalog, type Catalog } from '../../services/catalog.js';
import { feeOf } from '../../services/fees.js';
import type { StudentDoc } from '../../models/students.js';

export const maskAadhaar = (a: string) => (a.length >= 4 ? `XXXX XXXX ${a.slice(-4)}` : 'XXXX');

/** The signed-in student's own profile as the app shows it. Aadhaar is masked. */
export async function studentProfile(s: StudentDoc, cat?: Catalog) {
  const c = cat ?? (await loadCatalog());
  const cls = c.classes.get(s.classId);
  return {
    id: String(s._id),
    studentId: s.studentId,
    name: s.name,
    firstName: s.name.split(' ')[0],
    photo: s.photo,
    classId: s.classId,
    className: cls?.name ?? s.classId,
    batch: s.batch,
    phone: s.phone,
    email: s.email,
    gender: s.gender,
    dob: s.dob,
    aadhaar: maskAadhaar(s.aadhaar),
    fatherName: s.fatherName,
    motherName: s.motherName,
    guardianPhone: s.guardianPhone,
    school: s.school,
    board: s.board,
    targetExams: s.targetExams,
    subjects: (cls?.subjects ?? []).filter((x) => s.subjectIds.includes(x._id)).map((x) => ({ id: x._id, name: x.name, monthlyFee: x.monthlyFee })),
    extras: s.extras.map((id) => c.extras.get(id)).filter((e) => !!e).map((e) => ({ id: e._id, name: e.name, monthlyFee: e.monthlyFee })),
    courseIds: s.courseIds.map(String),
    admissionDate: s.admissionDate,
    durationMonths: s.durationMonths,
    validTill: s.validTill,
    idIssued: s.idIssued,
    roll: s.roll ?? '',
    address: s.address ?? '',
    previousResult: s.previousResult ? { className: s.previousResult.className, marks: s.previousResult.marks.map((m) => ({ subject: m.subject ?? '', marks: m.marks ?? '' })), total: s.previousResult.total } : undefined,
    fee: feeOf(s, c),
  };
}
