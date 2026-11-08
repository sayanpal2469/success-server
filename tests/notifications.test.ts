import { describe, expect, it } from 'vitest';

import { addDays, nowTimeIST, todayIST } from '../src/lib/time.js';
import { Exam } from '../src/models/tests.js';
import { adminToken, api, bearer, makeStudent, useDb } from './helpers.js';

useDb();

type Note = { id: string; type: string; title: string; body: string; href: string; read: boolean };
const list = async (token: string) => (await api().get('/api/v1/student/notifications').set(bearer(token)).expect(200)).body as { items: Note[]; unread: number };

describe('app notifications', () => {
  it('events reach the right students; read, read-all, delete and clear work', async () => {
    const admin = await adminToken();
    const a = await makeStudent({ classId: 'c10', subjectIds: ['c10-mathematics'] });
    const b = await makeStudent({ classId: 'c10', subjectIds: ['c10-bengali'] });
    const other = await makeStudent({ classId: 'c12', subjectIds: ['c12-physics'] });

    // Notice to everyone, a class notice, a draft (no bell) and a website-only notice (no bell).
    await api().post('/api/v1/admin/notices').set(bearer(admin)).send({ title: 'Holiday on Friday', body: '<p>Centre closed.</p>', audience: 'All students' }).expect(201);
    await api().post('/api/v1/admin/notices').set(bearer(admin)).send({ title: 'Class 10 parents meeting', audience: 'Class', target: 'c10' }).expect(201);
    const draft = await api().post('/api/v1/admin/notices').set(bearer(admin)).send({ title: 'Draft notice', audience: 'All students', status: 'DRAFT' }).expect(201);
    await api().post('/api/v1/admin/notices').set(bearer(admin)).send({ title: 'Website only', audience: 'Public website' }).expect(201);

    // A maths exam: only students who take maths in class 10.
    const start = new Date(Date.now() - 5 * 60_000);
    const ex = await api()
      .post('/api/v1/admin/exams')
      .set(bearer(admin))
      .send({ title: 'Unit test', classId: 'c10', subject: 'Mathematics', date: todayIST(start), start: nowTimeIST(start), duration: 60, questions: [{ text: '<p>Solve.</p>', marks: 10 }] })
      .expect(201);

    let na = await list(a.token);
    expect(na.items.map((n) => n.title)).toEqual(['New exam · Unit test', 'Class 10 parents meeting', 'Holiday on Friday']);
    expect(na.unread).toBe(3);
    expect(na.items[2]).toMatchObject({ type: 'notice', body: 'Centre closed.' });
    expect(na.items[0]!.href).toBe(`/exam/${ex.body.id}`);
    expect((await list(b.token)).items.map((n) => n.title)).toEqual(['Class 10 parents meeting', 'Holiday on Friday']);
    expect((await list(other.token)).items.map((n) => n.title)).toEqual(['Holiday on Friday']);

    // Publishing the draft sends it once; editing a live notice doesn't resend.
    await api().patch(`/api/v1/admin/notices/${draft.body.id}`).set(bearer(admin)).send({ status: 'LIVE' }).expect(200);
    await api().patch(`/api/v1/admin/notices/${draft.body.id}`).set(bearer(admin)).send({ title: 'Draft notice (edited)' }).expect(200);
    expect((await list(other.token)).items.filter((n) => n.title.startsWith('Draft notice'))).toHaveLength(1);

    // Payment and fee reminder.
    await api().post('/api/v1/admin/payments').set(bearer(admin)).send({ studentId: String(a.student._id), months: [todayIST().slice(0, 7)], method: 'Cash' }).expect(201);
    await api().post('/api/v1/admin/fee-reminders').set(bearer(admin)).send({ studentId: String(b.student._id), months: [addDays(todayIST(), -40).slice(0, 7)], amount: 500, phone: '9748133102' }).expect(201);
    na = await list(a.token);
    expect(na.items[0]).toMatchObject({ type: 'payment' });
    expect((await list(b.token)).items[0]).toMatchObject({ type: 'fee', title: 'Fee due · ₹500' });

    // Result: own marks for those who sat, "absent" for the rest of the exam's students.
    const sheets = await api().get(`/api/v1/admin/exams/${ex.body.id}/sheets`).set(bearer(admin)).expect(200);
    await api().put(`/api/v1/admin/exams/${ex.body.id}/marks/${a.student._id}`).set(bearer(admin)).send({ marks: { [sheets.body.exam.questions[0].id]: 8 } }).expect(200);
    await Exam.updateOne({ _id: ex.body.id }, { startsAt: new Date(Date.now() - 2 * 3600_000), endsAt: new Date(Date.now() - 3600_000) });
    await api().post(`/api/v1/admin/exams/${ex.body.id}/publish`).set(bearer(admin)).expect(200);
    na = await list(a.token);
    expect(na.items[0]).toMatchObject({ type: 'result', body: 'You scored 8 / 10 · rank 1 of 1.' });
    expect((await list(b.token)).items.some((n) => n.type === 'result')).toBe(false);

    // Read one, read all, delete one, clear read ones, clear all — only your own.
    const first = na.items[0]!;
    await api().patch(`/api/v1/student/notifications/${first.id}`).set(bearer(b.token)).send({ read: true }).expect(404);
    const r1 = await api().patch(`/api/v1/student/notifications/${first.id}`).set(bearer(a.token)).send({ read: true }).expect(200);
    expect(r1.body.read).toBe(true);
    expect((await list(a.token)).unread).toBe(na.unread - 1);
    await api().post('/api/v1/student/notifications/read-all').set(bearer(a.token)).expect(200);
    expect((await list(a.token)).unread).toBe(0);
    await api().delete(`/api/v1/student/notifications/${first.id}`).set(bearer(b.token)).expect(404);
    await api().delete(`/api/v1/student/notifications/${first.id}`).set(bearer(a.token)).expect(204);
    expect((await list(a.token)).items.some((n) => n.id === first.id)).toBe(false);

    const unreadB = (await list(b.token)).items.length;
    const del = await api().delete('/api/v1/student/notifications?read=1').set(bearer(b.token)).expect(200);
    expect(del.body.deleted).toBe(0);
    expect((await list(b.token)).items).toHaveLength(unreadB);
    await api().delete('/api/v1/student/notifications').set(bearer(a.token)).expect(200);
    expect((await list(a.token)).items).toHaveLength(0);
    expect((await list(b.token)).items).toHaveLength(unreadB);
    await api().get('/api/v1/student/notifications').expect(401);
  });
});
