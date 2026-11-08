import '../db/plugin.js';

import mongoose, { Schema, type InferSchemaType } from 'mongoose';

/* ───────────────────────── Notice board ───────────────────────── */

export const NOTICE_AUDIENCES = ['All students', 'Class', 'Public website'] as const;
export const NOTICE_KINDS = ['GENERAL', 'TOPPER', 'ROUTINE', 'EXAM'] as const;

/**
 * Status is derived, not stored: DRAFT if `draft`, SCHEDULED before `publishAt`, EXPIRED after
 * `expires` (last day shown, India date), otherwise LIVE.
 */
const noticeSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    body: { type: String, default: '' },
    image: String,
    audience: { type: String, enum: NOTICE_AUDIENCES, default: 'All students' },
    /** Class id when audience is "Class". */
    target: String,
    pinned: { type: Boolean, default: false },
    draft: { type: Boolean, default: false },
    publishAt: { type: Date, default: () => new Date() },
    expires: String,
    showOnWebsite: { type: Boolean, default: false },
    showOnApp: { type: Boolean, default: true },
    kind: { type: String, enum: NOTICE_KINDS, default: 'GENERAL' },
    by: { type: String, default: '' },
  },
  { timestamps: true },
);
noticeSchema.index({ publishAt: -1 });
export type NoticeDoc = InferSchemaType<typeof noticeSchema> & { _id: mongoose.Types.ObjectId };
export const Notice = mongoose.model('Notice', noticeSchema);

export type NoticeStatus = 'LIVE' | 'SCHEDULED' | 'EXPIRED' | 'DRAFT';
export function noticeStatus(n: Pick<NoticeDoc, 'draft' | 'publishAt' | 'expires'>, now: Date, today: string): NoticeStatus {
  if (n.draft) return 'DRAFT';
  if (n.publishAt > now) return 'SCHEDULED';
  if (n.expires && n.expires < today) return 'EXPIRED';
  return 'LIVE';
}

/* ───────────────────────── Banners ───────────────────────── */

const bannerSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, default: '' },
    placement: { type: String, enum: ['Website home hero', 'App home carousel'], default: 'Website home hero' },
    image: { type: String, required: true },
    cta: { type: String, default: '' },
    action: { type: String, default: '' },
    link: { type: String, default: '' },
    audience: { type: String, default: 'Everyone' },
    start: { type: String, required: true },
    end: String,
    active: { type: Boolean, default: true },
    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export type BannerDoc = InferSchemaType<typeof bannerSchema>;
export const Banner = mongoose.model('Banner', bannerSchema);

/* ───────────────────────── Website: student ranks & best teachers ───────────────────────── */

const rankerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    photo: String,
    exam: { type: String, default: '' },
    year: { type: String, default: '' },
    result: { type: String, default: '' },
    className: { type: String, default: '' },
    quote: { type: String, default: '' },
    visible: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const Ranker = mongoose.model('Ranker', rankerSchema);

/** A class (or extra curriculum) and one of its subjects a teacher takes. */
const assignmentSchema = new Schema(
  {
    groupId: { type: String, required: true },
    subject: { type: String, required: true, trim: true },
  },
  { _id: false },
);

/**
 * Teachers (admin › Teachers): staff details, teacher ID for the ID card, and the class subjects they
 * take. `visible` = shown as a "Best teacher" on the website (only the public fields are sent there).
 */
const teacherSchema = new Schema(
  {
    /** Teacher ID on the ID card, e.g. `TR-001`; given on create. */
    code: { type: String, trim: true },
    name: { type: String, required: true, trim: true },
    photo: String,
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    address: { type: String, default: '' },
    /** YYYY-MM-DD */
    joined: { type: String, default: '' },
    assignments: { type: [assignmentSchema], default: [] },
    /** Aadhaar scans, front and back (optional; private `/files/…`, never sent to the website). */
    aadhaarFront: String,
    aadhaarBack: String,
    /** Subject line on the website; the assigned subjects are used when empty. */
    subject: { type: String, default: '' },
    qualification: { type: String, default: '' },
    experience: { type: String, default: '' },
    about: { type: String, default: '' },
    visible: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
teacherSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
export const Teacher = mongoose.model('Teacher', teacherSchema);

/** Next free teacher ID (`TR-001`, `TR-002`, …). */
export async function nextTeacherCode() {
  const rows = await Teacher.find({ code: /^TR-\d+$/ }, { code: 1 }).lean();
  const max = rows.reduce((m, r) => Math.max(m, Number(r.code!.slice(3))), 0);
  return `TR-${String(max + 1).padStart(3, '0')}`;
}

/** Gives teachers added before teacher IDs existed an ID, in list order. */
export async function ensureTeacherCodes() {
  const missing = await Teacher.find({ $or: [{ code: { $exists: false } }, { code: null }, { code: '' }] }).sort({ order: 1, createdAt: 1 });
  for (const t of missing) {
    t.code = await nextTeacherCode();
    await t.save();
  }
}

/* ───────────────────────── Free classes (YouTube, per class) ───────────────────────── */

const freeVideoSchema = new Schema(
  {
    classId: { type: String, required: true, index: true },
    subject: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    url: { type: String, required: true },
    youtubeId: { type: String, required: true },
    duration: { type: String, default: '' },
    published: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const FreeVideo = mongoose.model('FreeVideo', freeVideoSchema);

/* ───────────────────────── Courses ───────────────────────── */

const lessonSchema = new Schema({
  title: { type: String, required: true, trim: true },
  kind: { type: String, enum: ['VIDEO', 'PDF'], required: true },
  source: { type: String, enum: ['YOUTUBE', 'UPLOAD'], required: true },
  url: { type: String, required: true },
  youtubeId: String,
  fileName: String,
  size: Number,
  duration: String,
  freePreview: { type: Boolean, default: false },
});

const moduleSchema = new Schema({
  title: { type: String, required: true, trim: true },
  lessons: { type: [lessonSchema], default: [] },
});

const courseSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, default: '' },
    description: { type: String, default: '' },
    cover: String,
    teacher: { type: String, default: '' },
    /** Who gets it besides students enrolled one by one (Student.courseIds). */
    access: {
      classes: { type: [String], default: [] },
      extras: { type: [String], default: [] },
    },
    published: { type: Boolean, default: false },
    modules: { type: [moduleSchema], default: [] },
  },
  { timestamps: true },
);
export type CourseDoc = InferSchemaType<typeof courseSchema> & { _id: mongoose.Types.ObjectId };
export const Course = mongoose.model('Course', courseSchema);

/** Lessons a student has marked done. */
const progressSchema = new Schema(
  {
    student: { type: Schema.Types.ObjectId, required: true },
    course: { type: Schema.Types.ObjectId, required: true },
    lesson: { type: Schema.Types.ObjectId, required: true },
    done: { type: Boolean, default: true },
  },
  { timestamps: true },
);
progressSchema.index({ student: 1, lesson: 1 }, { unique: true });
export const LessonProgress = mongoose.model('LessonProgress', progressSchema);

/* ───────────────────────── Website: reviews, gallery, blog, FAQs ───────────────────────── */

export const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

/** Reviews written on the website (shown only after the admin approves) or added by the admin. */
const reviewSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    /** e.g. "Parent of a Class 10 student". */
    role: { type: String, default: '' },
    text: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    /** Never shown on the website — lets the office check who wrote it. */
    phone: String,
    status: { type: String, enum: REVIEW_STATUSES, default: 'PENDING', index: true },
    source: { type: String, enum: ['WEBSITE', 'ADMIN'], default: 'WEBSITE' },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const Review = mongoose.model('Review', reviewSchema);

const galleryPhotoSchema = new Schema(
  {
    image: { type: String, required: true },
    caption: { type: String, default: '' },
    album: { type: String, default: 'Classroom' },
    visible: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const GalleryPhoto = mongoose.model('GalleryPhoto', galleryPhotoSchema);

const postSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    /** URL part: /blog/<slug>. */
    slug: { type: String, required: true, unique: true },
    excerpt: { type: String, default: '' },
    /** HTML from the panel's editor. */
    body: { type: String, default: '' },
    cover: String,
    tags: { type: [String], default: [] },
    /** Date shown on the post (YYYY-MM-DD). */
    date: { type: String, required: true },
    published: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const Post = mongoose.model('Post', postSchema);

const faqSchema = new Schema(
  {
    q: { type: String, required: true, trim: true },
    a: { type: String, required: true },
    visible: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const Faq = mongoose.model('Faq', faqSchema);
