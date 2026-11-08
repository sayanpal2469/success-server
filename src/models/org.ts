import '../db/plugin.js';

import mongoose, { Schema, type ClientSession, type InferSchemaType } from 'mongoose';

/* ───────────────────────── Admin ───────────────────────── */

const adminSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    active: { type: Boolean, default: true },
    lastLoginAt: Date,
  },
  { timestamps: true },
);
export type AdminDoc = InferSchemaType<typeof adminSchema>;
export const Admin = mongoose.model('Admin', adminSchema);

/* ───────────────────────── Sessions (refresh tokens) ───────────────────────── */

/**
 * One row per issued refresh token. Tokens rotate on every refresh; the old row is revoked and
 * points at its replacement. Presenting a revoked token again means it was stolen, so the whole
 * `family` (that device's login) is revoked.
 */
const sessionSchema = new Schema(
  {
    kind: { type: String, enum: ['ADMIN', 'STUDENT'], required: true },
    user: { type: Schema.Types.ObjectId, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    replacedBy: String,
    userAgent: String,
    ip: String,
  },
  { timestamps: true },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Session = mongoose.model('Session', sessionSchema);

/* ───────────────────────── Counters ───────────────────────── */

const counterSchema = new Schema({ _id: { type: String, required: true }, seq: { type: Number, default: 0 } });
export const Counter = mongoose.model('Counter', counterSchema);

/** Atomically takes the next number of a named sequence, starting after `floor`. */
export async function nextSeq(name: string, floor = 0, session?: ClientSession) {
  await Counter.updateOne({ _id: name }, { $setOnInsert: { seq: floor } }, { upsert: true, session });
  const c = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { returnDocument: 'after', session });
  return c!.seq;
}

/* ───────────────────────── Settings (single document) ───────────────────────── */

const contactSchema = new Schema(
  {
    phone: { type: String, default: '' },
    whatsapp: { type: String, default: '' },
    whatsappMessage: { type: String, default: 'Hello Success Tutorials, I want to know about admission.' },
    email: { type: String, default: '' },
    address: { type: String, default: 'Howrah, West Bengal' },
    hours: { type: String, default: 'Mon – Sat · 10 AM – 8 PM' },
    facebook: { type: String, default: '' },
    instagram: { type: String, default: '' },
    showCall: { type: Boolean, default: true },
    showWhatsApp: { type: Boolean, default: true },
    showMail: { type: Boolean, default: true },
  },
  { _id: false },
);

export const DEFAULT_REMINDER =
  'Dear Parent, this is a reminder from {institute}. The fee of {student} ({class}, ID {studentId}) for {months} — {amount} — is pending (due on {dueDate}). Please pay at the office at the earliest. Thank you.';

/**
 * Rules printed on the admission form (নিয়মাবলী). {admissionFee}, {monthlyFee} and {dueDay} are
 * filled in for each student.
 */
export const DEFAULT_ADMISSION_RULES = [
  'ভর্তির জন্য বিগত বছরের রেজাল্ট-এর জেরক্স এবং এক কপি পাসপোর্ট ছবি অবশ্যই জমা দিতে হইবে।',
  'ভর্তির ফর্ম জমা দেওয়ার সময় অ্যাডমিশন ফি বাবদ {admissionFee} টাকা দিতে হইবে।',
  'প্রতি মাসের মাহিনা (মাসের শেষে নয়) চলতি মাসের প্রথমে {dueDay} তারিখের মধ্যে দিতে হইবে।',
  'সমস্ত বিষয়ের মাসিক ফিস - {monthlyFee}/- টাকা।',
  'কোন ছাত্র-ছাত্রী যদি কোন রকম অশালীন আচরণ করে তবে সেই ছাত্র-ছাত্রীকে কোচিং-এ রাখা হবে কিনা সেই সিদ্ধান্ত শিক্ষক-শিক্ষিকা লইবেন।',
  'কোচিং কর্তৃপক্ষ কোন প্রয়োজনে অভিভাবককে ডাকিলে অবশ্যই দেখা করিতে হইবে।',
];

const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'main' },
    instituteName: { type: String, default: 'Success Tutorials' },
    centerHead: { type: String, default: '' },
    /** Centre head's signature image printed on ID cards and report cards. */
    signature: { type: String, default: '' },
    /** Student IDs are `${idPrefix}${4-digit number}`, e.g. ST26-0142. */
    idPrefix: { type: String, default: 'ST26-' },
    defaultDurationMonths: { type: Number, default: 12 },
    /** Whether the app's admission form accepts new requests. */
    admissionOpen: { type: Boolean, default: true },
    /** Monthly fees are due on this day of the month. */
    dueDay: { type: Number, default: 10, min: 1, max: 28 },
    /** WhatsApp fee reminder text; {student} {studentId} {class} {months} {amount} {dueDate} {institute} are filled in. */
    reminderTemplate: { type: String, default: DEFAULT_REMINDER },
    admissionRules: { type: [String], default: () => [...DEFAULT_ADMISSION_RULES] },
    /** Line under the name on the admission form, e.g. সঠিক সময়ে সঠিক দিশার অনন্য প্রতিষ্ঠান. */
    tagline: { type: String, default: 'সঠিক সময়ে সঠিক দিশার অনন্য প্রতিষ্ঠান' },
    contact: { type: contactSchema, default: () => ({}) },
    /** App check-in: on/off, and where the centre is (students must be within `radius` metres). */
    checkIn: {
      enabled: { type: Boolean, default: true },
      lat: Number,
      lng: Number,
      radius: { type: Number, default: 200, min: 20, max: 5000 },
    },
    /**
     * UPI shown in the app's Fees tab (Subjects & Fees › UPI payment). No gateway: the student pays,
     * the office checks it and records the payment. `qrImage` is the bank's own QR (public upload);
     * without it the app draws a QR from the UPI ID.
     */
    upi: {
      enabled: { type: Boolean, default: false },
      id: { type: String, default: '' },
      name: { type: String, default: '' },
      qrImage: { type: String, default: '' },
      note: { type: String, default: '' },
    },
  },
  { timestamps: true },
);
export type SettingsDoc = InferSchemaType<typeof settingsSchema>;
export const Settings = mongoose.model('Settings', settingsSchema);

export async function getSettings() {
  return (await Settings.findById('main')) ?? (await Settings.create({ _id: 'main' }));
}

/* ───────────────────────── Password reset codes (OTP by email) ───────────────────────── */

/** One live code per account; stored hashed, expires after 10 minutes, 5 wrong tries ends it. */
const resetCodeSchema = new Schema(
  {
    kind: { type: String, enum: ['ADMIN', 'STUDENT'], required: true },
    user: { type: Schema.Types.ObjectId, required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);
resetCodeSchema.index({ kind: 1, user: 1 }, { unique: true });
resetCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ResetCode = mongoose.model('ResetCode', resetCodeSchema);
