import { describe, expect, it } from 'vitest';

import { todayIST, weekday } from '../src/lib/time.js';
import { Attendance, Slot } from '../src/models/schedule.js';
import { adminToken, api, bearer, makeStudent, useDb } from './helpers.js';

useDb();

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
// Munshirhat, Howrah (roughly) and a point ~3 km away.
const CENTRE = { lat: 22.5545, lng: 88.0925 };
const FAR = { lat: 22.58, lng: 88.1 };

async function selfie(token: string) {
  const r = await api().post('/api/v1/student/uploads/checkin').set(bearer(token)).attach('file', JPG, { filename: 'selfie.jpg', contentType: 'image/jpeg' }).expect(201);
  return r.body.url as string;
}

describe('app check-in (selfie + GPS)', () => {
  it('checks in once a day near the centre and marks the student present', async () => {
    const admin = await adminToken();
    const today = todayIST();
    const a = await makeStudent({ classId: 'c10' });
    const b = await makeStudent({ classId: 'c10' });
    const noClass = await makeStudent({ classId: 'c12' });

    // No class for c10 yet today.
    let status = await api().get('/api/v1/student/attendance/check-in').set(bearer(a.token)).expect(200);
    expect(status.body).toMatchObject({ enabled: true, classToday: false, checkedIn: null, centre: null });
    const photo = await selfie(a.token);
    await api().post('/api/v1/student/attendance/check-in').set(bearer(a.token)).send({ photo, ...CENTRE }).expect(422);

    await Slot.create({ groupId: 'c10', day: weekday(today), start: '16:00', end: '17:00', subject: 'Mathematics', teacher: 'T', room: 'R' });
    await api().patch('/api/v1/admin/settings').set(bearer(admin)).send({ checkIn: { enabled: true, ...CENTRE, radius: 200 } }).expect(200);
    status = await api().get('/api/v1/student/attendance/check-in').set(bearer(a.token)).expect(200);
    expect(status.body).toMatchObject({ classToday: true, centre: { radius: 200 } });

    // Too far, fake location, bad photo path.
    await api().post('/api/v1/student/attendance/check-in').set(bearer(a.token)).send({ photo, ...FAR, accuracy: 15 }).expect(422);
    await api().post('/api/v1/student/attendance/check-in').set(bearer(a.token)).send({ photo, ...CENTRE, mocked: true }).expect(422);
    await api().post('/api/v1/student/attendance/check-in').set(bearer(a.token)).send({ photo: '/files/x.jpg', ...CENTRE }).expect(400);

    const ok = await api().post('/api/v1/student/attendance/check-in').set(bearer(a.token)).send({ photo, lat: CENTRE.lat + 0.0005, lng: CENTRE.lng, accuracy: 12, address: 'Munshirhat, Howrah' }).expect(201);
    expect(ok.body.inside).toBe(true);
    expect(ok.body.distance).toBeLessThan(100);
    await api().post('/api/v1/student/attendance/check-in').set(bearer(a.token)).send({ photo, ...CENTRE }).expect(409);
    await api().post('/api/v1/student/attendance/check-in').set(bearer(noClass.token)).send({ photo: await selfie(noClass.token), ...CENTRE }).expect(422);

    // Register: started by the check-in; a is present, b not yet; the office can finish it.
    const reg = await api().get(`/api/v1/admin/attendance/register?groupId=c10&date=${today}`).set(bearer(admin)).expect(200);
    expect(reg.body).toMatchObject({ taken: false, checkInOnly: true });
    const row = (id: unknown) => reg.body.students.find((s: { id: string }) => s.id === String(id));
    expect(row(a.student._id)).toMatchObject({ mark: 'P' });
    expect(row(a.student._id).checkedInAt).toBeTruthy();
    expect(row(b.student._id)).toMatchObject({ mark: 'A' });
    const perf = await api().get('/api/v1/student/performance').set(bearer(a.token)).expect(200);
    expect(perf.body.attendance).toMatchObject({ held: 1, present: 1 });

    // Admin sees the selfie (signed link) and location; undo removes the present mark.
    const list = await api().get('/api/v1/admin/attendance/check-ins').set(bearer(admin)).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ className: 'Class 10', address: 'Munshirhat, Howrah', inside: true });
    expect(list.body[0].selfie).toMatch(/^\/files\/.+\?exp=\d+&sig=/);
    await api().delete(`/api/v1/admin/attendance/check-ins/${list.body[0].id}`).set(bearer(admin)).expect(204);
    const after = await Attendance.findOne({ groupId: 'c10', date: today }).lean();
    expect(after!.marks).toHaveLength(0);

    // The office marks b present (no phone), then corrects it to absent.
    await api().post('/api/v1/admin/attendance/mark').set(bearer(admin)).send({ studentId: String(b.student._id), note: 'No phone' }).expect(201);
    let offices = (await api().get('/api/v1/admin/attendance/check-ins').set(bearer(admin)).expect(200)).body;
    expect(offices[0]).toMatchObject({ source: 'OFFICE', note: 'No phone', name: expect.any(String) });
    expect(offices[0].selfie).toBeUndefined();
    let regB = await Attendance.findOne({ groupId: 'c10', date: today }).lean();
    expect(regB!.marks.find((m) => String(m.student) === String(b.student._id))?.mark).toBe('P');
    const bStatus = await api().get('/api/v1/student/attendance/check-in').set(bearer(b.token)).expect(200);
    expect(bStatus.body.checkedIn).toBeTruthy();
    await api().post('/api/v1/admin/attendance/mark').set(bearer(admin)).send({ studentId: String(b.student._id), present: false }).expect(201);
    offices = (await api().get('/api/v1/admin/attendance/check-ins').set(bearer(admin)).expect(200)).body;
    expect(offices).toHaveLength(0);
    regB = await Attendance.findOne({ groupId: 'c10', date: today }).lean();
    expect(regB!.marks.find((m) => String(m.student) === String(b.student._id))?.mark).toBe('A');
    await api().post('/api/v1/admin/attendance/mark').set(bearer(admin)).send({ studentId: String(b.student._id), groupId: 'c12' }).expect(400);
    await api().post('/api/v1/admin/attendance/mark').set(bearer(admin)).send({ studentId: String(b.student._id), date: '2999-01-01' }).expect(400);

    // Turned off → refused.
    await api().patch('/api/v1/admin/settings').set(bearer(admin)).send({ checkIn: { enabled: false, ...CENTRE, radius: 200 } }).expect(200);
    await api().post('/api/v1/student/attendance/check-in').set(bearer(b.token)).send({ photo: await selfie(b.token), ...CENTRE }).expect(422);
  });
});
