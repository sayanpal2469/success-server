import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll } from 'vitest';

import { createApp } from '../src/app.js';
import { connectDb } from '../src/db/connect.js';
import { hashPassword } from '../src/lib/auth.js';
import { addDays, addMonthsInclusive, todayIST } from '../src/lib/time.js';
import { ClassDef, Extra } from '../src/models/catalog.js';
import { Admin, Settings } from '../src/models/org.js';
import { Student } from '../src/models/students.js';
import { classes, extras } from '../src/seed/data.js';

export const app = createApp();
export const api = () => request(app);

export const ADMIN = { email: 'admin@test.in', password: 'Admin@12345' };

/** Fresh database per test file, with the admin and the catalog in place. */
export function useDb() {
  beforeAll(async () => {
    if (mongoose.connection.readyState !== 1) await connectDb(process.env.MONGODB_URI!);
    await mongoose.connection.dropDatabase();
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
    await Admin.create({ name: 'Srijit Saha', email: ADMIN.email, passwordHash: await hashPassword(ADMIN.password) });
    await Settings.create({ _id: 'main', centerHead: 'Srijit Saha' });
    await ClassDef.insertMany(classes);
    await Extra.insertMany(extras);
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });
}

export async function adminToken() {
  const r = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return r.body.accessToken as string;
}

let n = 0;
/** A student admitted some months ago, signed in with password `pass1234`. */
export async function makeStudent(over: Record<string, unknown> = {}) {
  n++;
  const admissionDate = (over.admissionDate as string) ?? addDays(todayIST(), -70);
  const s = await Student.create({
    studentId: `ST26-${String(500 + n).padStart(4, '0')}`,
    name: `Student ${n}`,
    classId: 'c10',
    batch: 'Morning',
    phone: `+9198300${String(10000 + n).slice(-5)}`,
    gender: 'Female',
    dob: '2011-03-14',
    aadhaar: '123412341234',
    fatherName: 'Father',
    motherName: 'Mother',
    guardianPhone: '+919748133102',
    subjectIds: ['c10-bengali', 'c10-mathematics'],
    extras: [],
    admissionDate,
    durationMonths: 12,
    validTill: addMonthsInclusive(admissionDate, 12),
    idIssued: admissionDate,
    passwordHash: await hashPassword('pass1234'),
    ...over,
  });
  const r = await api().post('/api/v1/auth/student/login').send({ studentId: s.studentId, password: 'pass1234' }).expect(200);
  return { student: s, token: r.body.accessToken as string };
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
