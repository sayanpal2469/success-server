import type { Types } from 'mongoose';

import { todayIST, weekday } from '../lib/time.js';
import { Attendance, Slot } from '../models/schedule.js';

/** Metres between two GPS points (haversine). */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** The student's class (or one of their extra curriculums) that has a class today, if any. */
export async function groupToday(s: { classId: string; extras: string[] }, date = todayIST()) {
  const slots = await Slot.find({ groupId: { $in: [s.classId, ...s.extras] }, day: weekday(date) }, { groupId: 1, start: 1, end: 1, subject: 1 }).sort({ start: 1 }).lean();
  const own = slots.find((x) => x.groupId === s.classId) ?? slots[0];
  return { groupId: own?.groupId, slots };
}

/**
 * Present in today's register for the group. If the office hasn't taken the register yet, one is
 * started with just the students who checked in (`checkInOnly`); the office can finish it later.
 */
export const markPresent = (groupId: string, date: string, student: Types.ObjectId) => setMark(groupId, date, student, 'P');

/** One student's mark in a day's register (started as a check-in register if none exists yet). */
export async function setMark(groupId: string, date: string, student: Types.ObjectId, mark: 'P' | 'A', by = 'App check-in') {
  const reg = await Attendance.findOne({ groupId, date, batch: '' });
  if (!reg) {
    try {
      await Attendance.create({ groupId, date, batch: '', marks: [{ student, mark }], takenBy: by, checkInOnly: true });
      return;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  const res = await Attendance.updateOne({ groupId, date, batch: '', 'marks.student': student }, { $set: { 'marks.$.mark': mark } });
  if (!res.matchedCount) await Attendance.updateOne({ groupId, date, batch: '' }, { $push: { marks: { student, mark } } });
}
