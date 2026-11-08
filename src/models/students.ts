import '../db/plugin.js';

import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

export const GENDERS = ['Male', 'Female', 'Other'] as const;
export const PAY_METHODS = ['Cash', 'UPI', 'Bank transfer', 'Other'] as const;

/** Scans uploaded with the admission form. Private files — only the admin can open them. */
const documentsSchema = new Schema(
  {
    aadhaarFront: String,
    aadhaarBack: String,
    birthCertificate: String,
    marksheet: String,
  },
  { _id: false },
);

/** Last year's result (admission slip): class, marks per subject, total. Marks are text ("25", "A+"). */
const subjectMarkSchema = new Schema({ subject: { type: String, default: '' }, marks: { type: String, default: '' } }, { _id: false });
const previousResultSchema = new Schema(
  {
    className: { type: String, default: '' },
    marks: { type: [subjectMarkSchema], default: [] },
    total: { type: String, default: '' },
    /** Overall percentage, e.g. `82.5` (shown as 82.5% on the admission slip). */
    percentage: { type: String, default: '' },
  },
  { _id: false },
);

/** Fields a student fills in the admission form (app) or the office fills in (admin). */
const admissionFields = {
  name: { type: String, required: true, trim: true },
  classId: { type: String, required: true, index: true },
  phone: { type: String, required: true, index: true },
  gender: { type: String, enum: GENDERS, required: true },
  dob: { type: String, required: true },
  photo: String,
  email: String,
  aadhaar: { type: String, required: true },
  fatherName: { type: String, required: true },
  motherName: { type: String, required: true },
  guardianPhone: { type: String, required: true },
  school: { type: String, default: '' },
  board: { type: String, default: '' },
  targetExams: { type: [String], default: [] },
  subjectIds: { type: [String], default: [] },
  extras: { type: [String], default: [] },
  documents: { type: documentsSchema, default: () => ({}) },
  address: { type: String, default: '' },
  previousResult: { type: previousResultSchema, default: undefined },
} as const;

/* ───────────────────────── Students ───────────────────────── */

const studentSchema = new Schema(
  {
    ...admissionFields,
    /** Student ID printed on the ID card and used to sign in to the app, e.g. ST26-0142. */
    studentId: { type: String, required: true, unique: true, uppercase: true, trim: true },
    batch: { type: String, default: '' },
    /** Roll number in the class (printed on the admission slip). */
    roll: { type: String, default: '' },
    /** Courses granted one by one (besides those open to the whole class / extra curriculum). */
    courseIds: { type: [Schema.Types.ObjectId], default: [] },
    admissionDate: { type: String, required: true },
    durationMonths: { type: Number, required: true, min: 1, max: 60 },
    validTill: { type: String, required: true },
    /** Date the ID card was (re)issued. */
    idIssued: { type: String, required: true },
    /** Monthly discount in ₹. */
    discount: { type: Number, default: 0, min: 0 },
    discountReason: String,
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
    passwordHash: { type: String, required: true, select: false },
    /** Bumped on password reset so old app sessions stop working. */
    passwordChangedAt: Date,
    application: { type: Schema.Types.ObjectId, ref: 'Application' },
    /** Soft delete (admin › Students › Deleted students): hidden everywhere until restored. */
    deletedAt: Date,
    deletedBy: String,
  },
  { timestamps: true },
);
studentSchema.index({ name: 'text', studentId: 'text', phone: 'text' });
studentSchema.index({ classId: 1, status: 1 });
studentSchema.index({ deletedAt: 1 }, { sparse: true });
/** Students sign in with their email, so no two students share one. */
studentSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $gt: '' } } });

/**
 * Soft-deleted students are left out of every query unless the filter names `deletedAt` itself or
 * the query sets `{ withDeleted: true }` — so lists, counts, sign-in and the app all skip them.
 */
const SOFT_DELETE_OPS: ('find' | 'findOne' | 'countDocuments' | 'distinct' | 'findOneAndUpdate' | 'updateOne' | 'updateMany')[] = ['find', 'findOne', 'countDocuments', 'distinct', 'findOneAndUpdate', 'updateOne', 'updateMany'];
studentSchema.pre(SOFT_DELETE_OPS, function () {
  if ('deletedAt' in this.getFilter() || (this.getOptions() as { withDeleted?: boolean }).withDeleted) return;
  this.where({ deletedAt: null });
});
studentSchema.pre('aggregate', function () {
  const first = this.pipeline()[0] as { $match?: Record<string, unknown> } | undefined;
  if (first?.$match && 'deletedAt' in first.$match) return;
  this.pipeline().unshift({ $match: { deletedAt: null } });
});
export type StudentDoc = InferSchemaType<typeof studentSchema> & { _id: mongoose.Types.ObjectId };
export type StudentHydrated = HydratedDocument<StudentDoc>;
export const Student = mongoose.model('Student', studentSchema);

/* ───────────────────────── Admission requests (app or website) ───────────────────────── */

export const APPLY_SOURCES = ['APP', 'WEBSITE'] as const;

const applicationSchema = new Schema(
  {
    ...admissionFields,
    /** Reference the applicant sees, e.g. REQ-26-0318. */
    ref: { type: String, required: true, unique: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', index: true },
    /** Where the form was filled. */
    source: { type: String, enum: APPLY_SOURCES, default: 'APP' },
    rejectReason: String,
    /** Chosen in the form; copied onto the student on approval. */
    passwordHash: { type: String, required: true, select: false },
    student: { type: Schema.Types.ObjectId, ref: 'Student' },
    reviewedAt: Date,
  },
  { timestamps: true },
);
export const Application = mongoose.model('Application', applicationSchema);

/* ───────────────────────── Payments ───────────────────────── */

/**
 * No payment gateway: the teacher takes the money by hand and confirms it here, which issues a
 * receipt. `allocations` says how much went to each month, so a month can be paid in parts
 * (`partial` = something was still left after this payment). Payments made before partial payments
 * have no allocations and paid their months in full.
 */
const allocationSchema = new Schema({ month: { type: String, required: true }, amount: { type: Number, required: true, min: 0 } }, { _id: false });

const paymentSchema = new Schema(
  {
    receiptNo: { type: String, required: true, unique: true },
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    /** Months covered, `YYYY-MM`. */
    months: { type: [String], required: true },
    amount: { type: Number, required: true, min: 0 },
    allocations: { type: [allocationSchema], default: undefined },
    partial: { type: Boolean, default: false },
    method: { type: String, enum: PAY_METHODS, required: true },
    reference: String,
    note: String,
    receivedAt: { type: Date, required: true },
    receivedBy: { type: String, required: true },
    /** False once removed as a mistake (kept for the audit trail). */
    active: { type: Boolean, default: true },
    voidedAt: Date,
    voidedBy: String,
    voidReason: String,
  },
  { timestamps: true },
);
// Not unique: a month can now take several (partial) payments; recordPayment never lets them exceed the fee.
paymentSchema.index({ student: 1, months: 1 }, { name: 'student_months', partialFilterExpression: { active: true } });
paymentSchema.index({ receivedAt: -1 });
export type PaymentDoc = InferSchemaType<typeof paymentSchema> & { _id: mongoose.Types.ObjectId };
export const Payment = mongoose.model('Payment', paymentSchema);

/* ───────────────────────── Teacher feedback (performance tracker) ───────────────────────── */

const feedbackSchema = new Schema(
  {
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true, index: true },
    exam: { type: Schema.Types.ObjectId, ref: 'Exam' },
    text: { type: String, required: true, trim: true },
    by: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);
export const Feedback = mongoose.model('Feedback', feedbackSchema);

/* ───────────────────────── Fee reminders (sent by hand on WhatsApp) ───────────────────────── */

/**
 * The panel opens WhatsApp with a ready message; the office presses Send. This only records that a
 * reminder was sent, so the panel can show "reminded 2 days ago".
 */
const feeReminderSchema = new Schema(
  {
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true, index: true },
    months: { type: [String], default: [] },
    amount: { type: Number, default: 0 },
    phone: { type: String, required: true },
    channel: { type: String, enum: ['WHATSAPP'], default: 'WHATSAPP' },
    by: { type: String, required: true },
    at: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: false },
);
export const FeeReminder = mongoose.model('FeeReminder', feeReminderSchema);
