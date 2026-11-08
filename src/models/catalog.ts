import '../db/plugin.js';

import mongoose, { Schema, type InferSchemaType } from 'mongoose';

/**
 * Classes (Class 5 … 12, 1st – 4th year) and extra curriculums use short readable ids
 * (`c10`, `spoken`) because the same ids are stored on students, exams, routine slots and notices.
 */
const subjectSchema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    monthlyFee: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const classSchema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    group: { type: String, enum: ['School', 'College'], required: true },
    subjects: { type: [subjectSchema], default: [] },
    batches: { type: [String], default: [] },
    /** One-time charge collected with the first month. */
    admissionFee: { type: Number, default: 0, min: 0 },
    /** Open for admission. */
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export type ClassDoc = InferSchemaType<typeof classSchema>;
export const ClassDef = mongoose.model('Class', classSchema);

const extraSchema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    monthlyFee: { type: Number, required: true, min: 0 },
    teacher: { type: String, default: '' },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export type ExtraDoc = InferSchemaType<typeof extraSchema>;
export const Extra = mongoose.model('Extra', extraSchema);

export const ALL_SUBJECTS = 'All subjects';
