import '../db/plugin.js';

import mongoose, { Schema, type InferSchemaType } from 'mongoose';

export const NOTIFICATION_TYPES = ['test', 'result', 'notice', 'routine', 'fee', 'payment', 'general'] as const;

/**
 * One in-app notification for one student (the bell in the app). Made by the server when something
 * happens for that student — a notice, a new exam, a published result, a class change, a payment
 * or a fee reminder. The student reads and deletes them; old ones expire after 180 days.
 */
const notificationSchema = new Schema(
  {
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, default: 'general' },
    title: { type: String, required: true, trim: true },
    body: { type: String, default: '' },
    /** App screen to open, e.g. `/exam/<id>`. */
    href: { type: String, default: '' },
    read: { type: Boolean, default: false },
    readAt: Date,
  },
  { timestamps: true },
);
notificationSchema.index({ student: 1, createdAt: -1 });
notificationSchema.index({ student: 1, read: 1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });
export type NotificationDoc = InferSchemaType<typeof notificationSchema> & { _id: mongoose.Types.ObjectId };
export const Notification = mongoose.model('Notification', notificationSchema);
