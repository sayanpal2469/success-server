import { describe, expect, it } from 'vitest';

import { todayIST } from '../src/lib/time.js';
import { Attendance, CheckIn } from '../src/models/schedule.js';
import { Feedback, Payment, Student } from '../src/models/students.js';
import { adminToken, api, bearer, makeStudent, useDb } from './helpers.js';

useDb();

describe('deleting students', () => {
  it('soft delete hides a student and can be undone; hard delete removes them and their records', async () => {
    const admin = await adminToken();
    const today = todayIST();
    const a = await makeStudent();
    const b = await makeStudent();
    const keep = await makeStudent();
    const id = String(a.student._id);

    await Payment.create({ receiptNo: 'ST/26-27/09001', student: a.student._id, months: [today.slice(0, 7)], amount: 500, method: 'Cash', receivedAt: new Date(), receivedBy: 'Admin' });
    await Attendance.create({ groupId: 'c10', date: today, batch: '', marks: [{ student: a.student._id, mark: 'P' }, { student: keep.student._id, mark: 'A' }], takenBy: 'Admin' });
    await Feedback.create({ student: a.student._id, text: 'Good', by: 'Admin' });
    await CheckIn.create({ student: a.student._id, date: today, at: new Date(), groupId: 'c10', lat: 22.5, lng: 88.1 });

    // The pop-up shows where the student is used.
    const check = await api().post('/api/v1/admin/students/delete-check').set(bearer(admin)).send({ ids: [id, String(b.student._id)] }).expect(200);
    const linksA = check.body.find((r: { id: string }) => r.id === id);
    expect(linksA.links).toMatchObject({ payments: 1, attendance: 1, feedback: 1, checkIns: 1 });
    expect(check.body.find((r: { id: string }) => r.id === String(b.student._id)).links).toEqual({});

    // Soft delete: gone from the panel's lists and the app, records kept.
    await api().post('/api/v1/admin/students/delete').set(bearer(admin)).send({ ids: [id], mode: 'SOFT' }).expect(200);
    const all = (await api().get('/api/v1/admin/all/students').set(bearer(admin)).expect(200)).body;
    expect(all.some((s: { id: string }) => s.id === id)).toBe(false);
    expect((await api().get('/api/v1/admin/all/payments').set(bearer(admin)).expect(200)).body).toHaveLength(0);
    const att = (await api().get('/api/v1/admin/all/attendance').set(bearer(admin)).expect(200)).body;
    expect(Object.keys(att[0].marks)).toEqual([String(keep.student._id)]);
    await api().get(`/api/v1/admin/students/${id}`).set(bearer(admin)).expect(404);
    await api().get('/api/v1/student/me').set(bearer(a.token)).expect(401);
    await api().post('/api/v1/auth/student/login').send({ studentId: a.student.studentId, password: 'pass1234' }).expect(401);
    expect(await Payment.countDocuments({ student: a.student._id })).toBe(1);

    const deleted = (await api().get('/api/v1/admin/students/deleted').set(bearer(admin)).expect(200)).body;
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ id, deletedBy: expect.any(String) });

    // Restore: back with everything.
    await api().post('/api/v1/admin/students/restore').set(bearer(admin)).send({ ids: [id] }).expect(200);
    expect((await api().get('/api/v1/admin/all/payments').set(bearer(admin)).expect(200)).body).toHaveLength(1);
    await api().post('/api/v1/auth/student/login').send({ studentId: a.student.studentId, password: 'pass1234' }).expect(200);
    expect((await api().get('/api/v1/admin/students/deleted').set(bearer(admin)).expect(200)).body).toHaveLength(0);

    // Hard delete (also works on a soft-deleted student): the student and all their records go.
    await api().post('/api/v1/admin/students/delete').set(bearer(admin)).send({ ids: [String(b.student._id)], mode: 'SOFT' }).expect(200);
    const hard = await api().post('/api/v1/admin/students/delete').set(bearer(admin)).send({ ids: [id, String(b.student._id)], mode: 'HARD' }).expect(200);
    expect(hard.body.count).toBe(2);
    expect(await Student.countDocuments({ _id: { $in: [a.student._id, b.student._id] } }).setOptions({ withDeleted: true })).toBe(0);
    expect(await Payment.countDocuments({ student: a.student._id })).toBe(0);
    expect(await Feedback.countDocuments({ student: a.student._id })).toBe(0);
    expect(await CheckIn.countDocuments({ student: a.student._id })).toBe(0);
    const reg = await Attendance.findOne({ groupId: 'c10', date: today }).lean();
    expect(reg!.marks.map((m) => String(m.student))).toEqual([String(keep.student._id)]);
    expect(await Student.exists({ _id: keep.student._id })).toBeTruthy();

    await api().post('/api/v1/admin/students/delete').set(bearer(admin)).send({ ids: [], mode: 'HARD' }).expect(400);
    await api().post('/api/v1/admin/students/delete').set(bearer(admin)).send({ ids: [String(keep.student._id)], mode: 'NUKE' }).expect(400);
  });
});
