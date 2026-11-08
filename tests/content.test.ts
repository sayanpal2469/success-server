import { describe, expect, it } from 'vitest';

import { addDays, todayIST, weekday } from '../src/lib/time.js';
import { adminToken, api, bearer, makeStudent, useDb } from './helpers.js';

useDb();

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ad2d6b7a0000000049454e44ae426082', 'hex');

describe('notice board', () => {
  it('shows class notices only to that class and website notices on the website', async () => {
    const admin = await adminToken();
    await api().post('/api/v1/admin/notices').set(bearer(admin)).send({ title: 'For c10', audience: 'Class', target: 'c10' }).expect(201);
    await api().post('/api/v1/admin/notices').set(bearer(admin)).send({ title: 'For c12', audience: 'Class', target: 'c12' }).expect(201);
    await api().post('/api/v1/admin/notices').set(bearer(admin)).send({ title: 'Everyone', showOnWebsite: true, pinned: true }).expect(201);
    await api().post('/api/v1/admin/notices').set(bearer(admin)).send({ title: 'Draft', status: 'DRAFT' }).expect(201);
    await api().post('/api/v1/admin/notices').set(bearer(admin)).send({ title: 'Old', expires: addDays(todayIST(), -1) }).expect(201);
    await api().post('/api/v1/admin/notices').set(bearer(admin)).send({ title: 'Class without target', audience: 'Class' }).expect(400);

    const { token } = await makeStudent();
    const mine = await api().get('/api/v1/student/notices').set(bearer(token)).expect(200);
    expect(mine.body.map((n: { title: string }) => n.title)).toEqual(['Everyone', 'For c10']);
    const web = await api().get('/api/v1/public/announcements').expect(200);
    expect(web.body.map((n: { title: string }) => n.title)).toEqual(['Everyone']);
    const all = await api().get('/api/v1/admin/notices?status=EXPIRED').set(bearer(admin)).expect(200);
    expect(all.body.map((n: { title: string }) => n.title)).toEqual(['Old']);
  });
});

describe('routine and attendance', () => {
  it('postponing a class notifies its students; the register feeds the app', async () => {
    const admin = await adminToken();
    const { student, token } = await makeStudent();
    const today = todayIST();
    const slot = await api()
      .post('/api/v1/admin/routine')
      .set(bearer(admin))
      .send({ groupId: 'c10', day: weekday(today), start: '16:00', end: '17:00', subject: 'Mathematics', teacher: 'Srijit Saha' })
      .expect(201);
    await api().post('/api/v1/admin/routine').set(bearer(admin)).send({ groupId: 'c10', day: 0, start: '16:00', end: '17:00', subject: 'Physics' }).expect(201);

    const r = await api().get('/api/v1/student/routine').set(bearer(token)).expect(200);
    // Physics is not one of the student's subjects
    expect(r.body.slots.map((s: { subject: string }) => s.subject)).toEqual(['Mathematics']);

    await api()
      .post('/api/v1/admin/routine/changes')
      .set(bearer(admin))
      .send({ slotId: slot.body.id, date: addDays(today, 1), kind: 'CANCELLED' })
      .expect(400);
    await api()
      .post('/api/v1/admin/routine/changes')
      .set(bearer(admin))
      .send({ slotId: slot.body.id, date: today, kind: 'POSTPONED', newDate: addDays(today, 1), newStart: '18:00', reason: 'Teacher unwell' })
      .expect(201);
    const notices = await api().get('/api/v1/student/notices').set(bearer(token)).expect(200);
    const routine = notices.body.find((n: { kind: string }) => n.kind === 'ROUTINE');
    expect(routine.title).toContain('postponed');
    expect(routine.body).toContain('Teacher unwell');

    const reg = await api().get(`/api/v1/admin/attendance/register?groupId=c10&date=${today}`).set(bearer(admin)).expect(200);
    expect(reg.body.students.find((s: { id: string }) => s.id === String(student._id)).mark).toBe('P');
    await api()
      .put('/api/v1/admin/attendance/register')
      .set(bearer(admin))
      .send({ groupId: 'c10', date: today, absent: [String(student._id)] })
      .expect(200);
    await api().put('/api/v1/admin/attendance/register').set(bearer(admin)).send({ groupId: 'c10', date: addDays(today, 1) }).expect(400);

    const att = await api().get('/api/v1/student/attendance').set(bearer(token)).expect(200);
    expect(att.body).toMatchObject({ held: 1, present: 0, absent: 1 });
    const report = await api().get('/api/v1/admin/attendance/report?groupId=c10').set(bearer(admin)).expect(200);
    expect(report.body.students[0].classes.percent).toBe(0);
  });
});

describe('courses, free classes and uploads', () => {
  it('course access follows class / extra curriculum / single enrolment', async () => {
    const admin = await adminToken();
    const c = await api()
      .post('/api/v1/admin/courses')
      .set(bearer(admin))
      .send({
        title: 'Spoken English',
        access: { extras: ['spoken'] },
        published: true,
        modules: [{ title: 'Week 1', lessons: [{ title: 'Hello', kind: 'VIDEO', source: 'YOUTUBE', url: 'https://youtu.be/IlNAJl36-10' }] }],
      })
      .expect(201);
    expect(c.body.modules[0].lessons[0].youtubeId).toBe('IlNAJl36-10');
    const withExtra = await makeStudent({ extras: ['spoken'] });
    const without = await makeStudent();
    expect((await api().get('/api/v1/student/courses').set(bearer(withExtra.token)).expect(200)).body).toHaveLength(1);
    expect((await api().get('/api/v1/student/courses').set(bearer(without.token)).expect(200)).body).toHaveLength(0);
    await api().get(`/api/v1/student/courses/${c.body.id}`).set(bearer(without.token)).expect(403);

    await api().post(`/api/v1/admin/courses/${c.body.id}/students`).set(bearer(admin)).send({ add: [String(without.student._id)] }).expect(204);
    const detail = await api().get(`/api/v1/student/courses/${c.body.id}`).set(bearer(without.token)).expect(200);
    const lessonId = detail.body.modules[0].lessons[0].id;
    await api().put(`/api/v1/student/lessons/${lessonId}/progress`).set(bearer(without.token)).send({ done: true }).expect(204);
    const list = await api().get('/api/v1/student/courses').set(bearer(without.token)).expect(200);
    expect(list.body[0]).toMatchObject({ lessons: 1, done: 1 });
  });

  it('free videos need a YouTube link and show per class', async () => {
    const admin = await adminToken();
    await api().post('/api/v1/admin/free-videos').set(bearer(admin)).send({ classId: 'c9', subject: 'Mathematics', title: 'x', url: 'https://example.com/v' }).expect(400);
    await api().post('/api/v1/admin/free-videos').set(bearer(admin)).send({ classId: 'c9', subject: 'Mathematics', title: 'Algebra', url: 'https://www.youtube.com/watch?v=IlNAJl36-10' }).expect(201);
    const r = await api().get('/api/v1/public/free-videos?classId=c9').expect(200);
    expect(r.body[0]).toMatchObject({ title: 'Algebra', youtubeId: 'IlNAJl36-10' });
  });

  it('uploads check the real file type; private documents need a signed link', async () => {
    const admin = await adminToken();
    const img = await api().post('/api/v1/admin/uploads/image').set(bearer(admin)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(201);
    expect(img.body.url).toMatch(/^\/uploads\/[a-f0-9]{32}\.png$/);
    await api().get(img.body.url).expect(200);
    await api()
      .post('/api/v1/admin/uploads/image')
      .set(bearer(admin))
      .attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'x.png', contentType: 'image/png' })
      .expect(400);

    const doc = await api().post('/api/v1/public/uploads/document').attach('file', PNG, { filename: 'aadhaar.png', contentType: 'image/png' }).expect(201);
    expect(doc.body.url).toMatch(/^\/files\//);
    await api().get(doc.body.url).expect(403);
    const { student } = await makeStudent({ documents: { aadhaarFront: doc.body.url } });
    const s = await api().get(`/api/v1/admin/students/${student._id}`).set(bearer(admin)).expect(200);
    expect(s.body.documents.aadhaarFront).toMatch(/\?exp=\d+&sig=/);
    await api().get(s.body.documents.aadhaarFront).expect(200);
  });

  it('classes: a subject still taken by students cannot be removed', async () => {
    const admin = await adminToken();
    await makeStudent();
    const cls = (await api().get('/api/v1/admin/classes').set(bearer(admin)).expect(200)).body.find((c: { id: string }) => c.id === 'c10');
    expect(cls.subjects.find((s: { id: string }) => s.id === 'c10-mathematics').students).toBeGreaterThan(0);
    const without = cls.subjects.filter((s: { id: string }) => s.id !== 'c10-mathematics');
    await api().patch('/api/v1/admin/classes/c10').set(bearer(admin)).send({ subjects: without }).expect(409);
    const more = [...cls.subjects.map(({ id, name, monthlyFee }: { id: string; name: string; monthlyFee: number }) => ({ id, name, monthlyFee })), { name: 'Computer', monthlyFee: 300 }];
    const ok = await api().patch('/api/v1/admin/classes/c10').set(bearer(admin)).send({ subjects: more }).expect(200);
    expect(ok.body.subjects.at(-1)).toMatchObject({ id: 'c10-computer', monthlyFee: 300 });
  });
});
