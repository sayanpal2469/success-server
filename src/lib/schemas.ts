import { z } from 'zod';

import { GENDERS } from '../models/students.js';
import { zAadhaar, zCode, zDate, zEmail, zName, zPhone, zText } from './validate.js';

export const BOARDS = ['WBBSE', 'WBCHSE', 'CBSE', 'ICSE', 'ISC', 'University'];
export const TARGET_EXAMS = ['Madhyamik', 'Higher Secondary', 'Board exams', 'WBJEE', 'JEE Main', 'NEET', 'Olympiad', 'CUET', 'University exams'];

const zUpload = (prefix: '/uploads/' | '/files/') =>
  z
    .string()
    .trim()
    .max(300)
    .refine((v) => v.startsWith(prefix) || (prefix === '/uploads/' && /^https:\/\//.test(v)), `Upload the file first (${prefix}…)`);

/** Admission form fields (app form and the office's New admission form). */
export const zAdmission = z.object({
  name: zName,
  classId: zCode,
  phone: zPhone,
  gender: z.enum(GENDERS),
  dob: zDate,
  photo: zUpload('/uploads/').optional(),
  email: zEmail,
  aadhaar: zAadhaar,
  fatherName: zName,
  motherName: zName,
  guardianPhone: zPhone,
  school: zText(160).default(''),
  board: zText(40).default(''),
  targetExams: z.array(zText(60)).max(10).default([]),
  subjectIds: z.array(zCode).max(20).default([]),
  extras: z.array(zCode).max(10).default([]),
  address: zText(300).default(''),
  /** Last year's result as on the admission slip: class, marks per subject, total. */
  previousResult: z
    .object({
      className: zText(40).default(''),
      marks: z.array(z.object({ subject: zText(40), marks: zText(12) })).max(20).default([]),
      total: zText(20).default(''),
      percentage: zText(12).default(''),
    })
    .optional(),
  documents: z
    .object({
      aadhaarFront: zUpload('/files/').optional(),
      aadhaarBack: zUpload('/files/').optional(),
      birthCertificate: zUpload('/files/').optional(),
      marksheet: zUpload('/files/').optional(),
    })
    .default({}),
});
export type AdmissionInput = z.infer<typeof zAdmission>;
