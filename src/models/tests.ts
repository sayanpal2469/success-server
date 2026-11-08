import '../db/plugin.js';

import mongoose, { Schema, type InferSchemaType } from 'mongoose';

import { istInstant } from '../lib/time.js';

/** Four options, `answer` is the index of the right one (0 = A). */
const questionSchema = new Schema({
  q: { type: String, required: true },
  options: { type: [String], required: true, validate: (v: string[]) => v.length === 4 },
  answer: { type: Number, required: true, min: 0, max: 3 },
  explanation: String,
});
export type QuestionDoc = InferSchemaType<typeof questionSchema> & { _id: mongoose.Types.ObjectId };

const scoring = {
  /** Minutes, 10 – 360. */
  duration: { type: Number, required: true, min: 10, max: 360 },
  marksPerQ: { type: Number, required: true, min: 0 },
  /** Marks taken off per wrong answer. */
  negative: { type: Number, default: 0, min: 0 },
  questions: { type: [questionSchema], default: [] },
  sourceFile: String,
  instructions: { type: String, default: '' },
} as const;

/* ───────────────────────── Written exams ───────────────────────── */

/**
 * A question on a written (pen and paper) exam: long answers, not MCQ. `text` is HTML from the
 * panel's editor; `section` groups questions under a heading on the paper (e.g. "Group A").
 */
const writtenQuestionSchema = new Schema({
  section: { type: String, default: '' },
  text: { type: String, required: true },
  marks: { type: Number, required: true, min: 0, max: 1000 },
  /** Optional figure (uploaded image). */
  image: String,
});
export type WrittenQuestionDoc = InferSchemaType<typeof writtenQuestionSchema> & { _id: mongoose.Types.ObjectId };

/**
 * Students see the question paper in the app from the start time, write the answers in their
 * notebook (khata), then either upload photos of it as a PDF or hand the notebook in at the centre.
 * The admin enters the marks; published results feed the exam and annual report cards.
 */
const examSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    classId: { type: String, required: true, index: true },
    /** A subject name of the class, or "All subjects". */
    subject: { type: String, required: true },
    date: { type: String, required: true },
    start: { type: String, required: true },
    /** Minutes, 10 – 360. */
    duration: { type: Number, required: true, min: 10, max: 360 },
    instructions: { type: String, default: '' },
    questions: { type: [writtenQuestionSchema], default: [] },
    /** Sum of the question marks (kept in sync on save). */
    fullMarks: { type: Number, default: 0 },
    /** Answer PDFs can be uploaded until this many minutes after the exam ends. */
    uploadMinutes: { type: Number, default: 120, min: 0, max: 10_080 },
    /** Derived from date + start + duration (India time). */
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    resultsPublished: { type: Boolean, default: false },
    publishedAt: Date,
    topperNotice: { type: Schema.Types.ObjectId, ref: 'Notice' },
  },
  { timestamps: true },
);
examSchema.pre('validate', function () {
  if (this.date && this.start && this.duration) {
    this.startsAt = istInstant(this.date, this.start);
    this.endsAt = new Date(this.startsAt.getTime() + this.duration * 60_000);
  }
  this.fullMarks = Math.round(this.questions.reduce((a, q) => a + (q.marks ?? 0), 0) * 100) / 100;
});
export type ExamDoc = InferSchemaType<typeof examSchema> & { _id: mongoose.Types.ObjectId };
export const Exam = mongoose.model('Exam', examSchema);

/** Last moment an answer PDF is accepted. */
export const uploadDeadline = (e: Pick<ExamDoc, 'endsAt' | 'uploadMinutes'>) => new Date(e.endsAt.getTime() + (e.uploadMinutes ?? 120) * 60_000);

export type ExamStatus = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'PUBLISHED';
export function examStatus(e: Pick<ExamDoc, 'resultsPublished' | 'startsAt' | 'endsAt'>, now = new Date()): ExamStatus {
  if (e.resultsPublished) return 'PUBLISHED';
  if (now < e.startsAt) return 'SCHEDULED';
  if (now <= e.endsAt) return 'LIVE';
  return 'ENDED';
}

/* ───────────────────────── Mock tests (practice, any time while open) ───────────────────────── */

const mockSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    classId: { type: String, required: true, index: true },
    subject: { type: String, required: true },
    ...scoring,
    openFrom: { type: String, required: true },
    /** Last day it can be taken; empty = no end. */
    openTill: String,
    /** 0 = unlimited. */
    attemptsAllowed: { type: Number, default: 1, min: 0, max: 50 },
    /** Show right answers and explanations after submitting. */
    showAnswers: { type: Boolean, default: true },
    published: { type: Boolean, default: false },
  },
  { timestamps: true },
);
export type MockDoc = InferSchemaType<typeof mockSchema> & { _id: mongoose.Types.ObjectId };
export const MockTest = mongoose.model('MockTest', mockSchema);

export type MockStatus = 'DRAFT' | 'UPCOMING' | 'OPEN' | 'CLOSED';
export const mockStatus = (m: Pick<MockDoc, 'published' | 'openFrom' | 'openTill'>, today: string): MockStatus =>
  !m.published ? 'DRAFT' : today < m.openFrom ? 'UPCOMING' : m.openTill && today > m.openTill ? 'CLOSED' : 'OPEN';

/* ───────────────────────── Attempts (online mock tests) ───────────────────────── */

/**
 * Timer and scoring are server-side. `deadline` is fixed at start; answers saved after it are
 * ignored. A mock allows `attemptsAllowed`. (`kind: 'EXAM'` rows are from the old online exams.)
 */
const attemptSchema = new Schema(
  {
    kind: { type: String, enum: ['EXAM', 'MOCK'], required: true },
    test: { type: Schema.Types.ObjectId, required: true },
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    attemptNo: { type: Number, default: 1 },
    status: { type: String, enum: ['IN_PROGRESS', 'SUBMITTED'], default: 'IN_PROGRESS' },
    startedAt: { type: Date, required: true },
    deadline: { type: Date, required: true },
    submittedAt: Date,
    /** question id → chosen option index. */
    answers: { type: Map, of: Number, default: () => new Map() },
    /** Times the app went to the background during the attempt. */
    appSwitches: { type: Number, default: 0 },
    score: Number,
    correct: Number,
    wrong: Number,
    skipped: Number,
    /** Seconds used. */
    timeSec: Number,
  },
  { timestamps: true },
);
attemptSchema.index({ kind: 1, test: 1, student: 1, attemptNo: 1 }, { unique: true });
attemptSchema.index({ student: 1, kind: 1 });
export type AttemptDoc = InferSchemaType<typeof attemptSchema> & { _id: mongoose.Types.ObjectId };
export const Attempt = mongoose.model('Attempt', attemptSchema);

/* ───────────────────────── Written exam answer sheets ───────────────────────── */

export const SUBMIT_MODES = ['UPLOAD', 'MANUAL'] as const;
export const SHEET_STATUSES = ['SUBMITTED', 'CHECKED', 'ABSENT'] as const;

/**
 * One per student per exam. UPLOAD: photos of the notebook as a PDF (private file). MANUAL: the
 * notebook was handed in at the centre (by the student in the app, or recorded by the office).
 * CHECKED once the admin has entered marks; ABSENT when the admin marks the student absent.
 */
const submissionSchema = new Schema(
  {
    exam: { type: Schema.Types.ObjectId, ref: 'Exam', required: true },
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    mode: { type: String, enum: SUBMIT_MODES, required: true },
    /** Who recorded it: the student in the app, or the office while entering marks. */
    by: { type: String, enum: ['STUDENT', 'OFFICE'], default: 'STUDENT' },
    /** `/files/<name>.pdf` (private) for uploads. */
    file: String,
    pages: Number,
    submittedAt: Date,
    /** Uploaded after the exam ended (still within the upload window). */
    late: { type: Boolean, default: false },
    status: { type: String, enum: SHEET_STATUSES, default: 'SUBMITTED' },
    /** question id → marks given. */
    marks: { type: Map, of: Number, default: undefined },
    total: Number,
    remarks: { type: String, default: '' },
    checkedAt: Date,
    checkedBy: String,
  },
  { timestamps: true },
);
submissionSchema.index({ exam: 1, student: 1 }, { unique: true });
submissionSchema.index({ student: 1 });
export type SubmissionDoc = InferSchemaType<typeof submissionSchema> & { _id: mongoose.Types.ObjectId };
export const ExamSubmission = mongoose.model('ExamSubmission', submissionSchema);
