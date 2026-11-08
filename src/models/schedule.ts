import '../db/plugin.js';

import mongoose, { Schema } from 'mongoose';

/* ───────────────────────── Weekly routine ───────────────────────── */

/** `groupId` is a class id (c5 … y4) or an extra-curriculum id (drawing, spoken …). */
const slotSchema = new Schema(
  {
    groupId: { type: String, required: true, index: true },
    batch: { type: String, default: '' },
    /** Monday = 0 … Sunday = 6. */
    day: { type: Number, required: true, min: 0, max: 6 },
    start: { type: String, required: true },
    end: { type: String, required: true },
    subject: { type: String, required: true },
    teacher: { type: String, default: '' },
    room: { type: String, default: '' },
  },
  { timestamps: true },
);
export const Slot = mongoose.model('Slot', slotSchema);

/** A class postponed or cancelled on one date (or an extra class). Creates a ROUTINE notice. */
const routineChangeSchema = new Schema(
  {
    slot: { type: Schema.Types.ObjectId, ref: 'Slot', required: true },
    groupId: { type: String, required: true, index: true },
    date: { type: String, required: true },
    kind: { type: String, enum: ['POSTPONED', 'CANCELLED', 'EXTRA'], required: true },
    newDate: String,
    newStart: String,
    newEnd: String,
    reason: { type: String, default: '' },
    notice: { type: Schema.Types.ObjectId, ref: 'Notice' },
  },
  { timestamps: true },
);
routineChangeSchema.index({ slot: 1, date: 1 }, { unique: true });
export const RoutineChange = mongoose.model('RoutineChange', routineChangeSchema);

/* ───────────────────────── Attendance ───────────────────────── */

/**
 * One register per group (class or extra curriculum), date and batch (`''` = whole group).
 * `marks` keeps the roster as it was that day so later admissions don't change old registers.
 */
const attendanceSchema = new Schema(
  {
    groupId: { type: String, required: true },
    date: { type: String, required: true },
    batch: { type: String, default: '' },
    marks: {
      type: [
        new Schema(
          { student: { type: Schema.Types.ObjectId, ref: 'Student', required: true }, mark: { type: String, enum: ['P', 'A'], required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
    takenBy: String,
    alertGuardians: { type: Boolean, default: false },
    /** Made by students checking in from the app; the office hasn't taken the full register yet. */
    checkInOnly: { type: Boolean, default: false },
  },
  { timestamps: true },
);
attendanceSchema.index({ groupId: 1, date: 1, batch: 1 }, { unique: true });
attendanceSchema.index({ 'marks.student': 1, date: 1 });
export const Attendance = mongoose.model('Attendance', attendanceSchema);

/* ───────────────────────── App check-in (selfie + GPS) ───────────────────────── */

/**
 * A student marking themselves present from the app: a front-camera selfie stamped with the date,
 * time and GPS position (like a GPS camera), plus the raw location. One per student per day; it
 * marks them present in that day's register for their class.
 */
const checkInSchema = new Schema(
  {
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    date: { type: String, required: true },
    at: { type: Date, required: true },
    groupId: { type: String, required: true },
    /** APP: the student checked in with a selfie. OFFICE: the admin marked them present. */
    source: { type: String, enum: ['APP', 'OFFICE'], default: 'APP' },
    /** Admin's name for OFFICE entries. */
    by: String,
    note: { type: String, default: '' },
    /** `/files/<name>.jpg` (private — only the admin opens it with a signed link). App check-ins only. */
    photo: String,
    lat: Number,
    lng: Number,
    /** GPS accuracy in metres. */
    accuracy: { type: Number, default: 0 },
    address: { type: String, default: '' },
    /** Metres from the centre (when the centre location is set). */
    distance: Number,
    /** Within the allowed radius of the centre (null when the centre isn't set). */
    inside: { type: Boolean, default: null },
  },
  { timestamps: true },
);
checkInSchema.index({ student: 1, date: 1 }, { unique: true });
checkInSchema.index({ date: 1, at: 1 });
export const CheckIn = mongoose.model('CheckIn', checkInSchema);
