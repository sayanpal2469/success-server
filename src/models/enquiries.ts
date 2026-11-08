import '../db/plugin.js';

import mongoose, { Schema, type InferSchemaType } from 'mongoose';

export const ENQUIRY_KINDS = ['ENQUIRY', 'DEMO'] as const;
export const ENQUIRY_STATUSES = ['NEW', 'CONTACTED', 'CLOSED'] as const;

/**
 * Enquiry / free-demo form on the website. The visitor asks about a class (and some of its
 * subjects or extra curriculums) or about one of the online courses; the office calls back.
 */
const enquirySchema = new Schema(
  {
    kind: { type: String, enum: ENQUIRY_KINDS, default: 'ENQUIRY' },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, index: true },
    classId: String,
    subjectIds: { type: [String], default: [] },
    extras: { type: [String], default: [] },
    course: { type: Schema.Types.ObjectId, ref: 'Course' },
    /** Preferred demo slot. */
    slot: String,
    message: { type: String, default: '' },
    /** utm_* parameters of the page the form was sent from. */
    utm: { type: Map, of: String, default: undefined },
    status: { type: String, enum: ENQUIRY_STATUSES, default: 'NEW', index: true },
    /** Office's own note (who called, what was said). */
    note: { type: String, default: '' },
    contactedAt: Date,
  },
  { timestamps: true },
);
enquirySchema.index({ createdAt: -1 });
export type EnquiryDoc = InferSchemaType<typeof enquirySchema> & { _id: mongoose.Types.ObjectId };
export const Enquiry = mongoose.model('Enquiry', enquirySchema);
