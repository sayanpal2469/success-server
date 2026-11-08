import { describe, expect, it } from 'vitest';

import { adminToken, api, bearer, makeStudent, useDb } from './helpers.js';

useDb();

describe('WhatsApp fee reminders', () => {
  it('logs reminders and keeps an editable message template', async () => {
    const token = await adminToken();
    const { student } = await makeStudent();

    const s = await api().get('/api/v1/admin/settings').set(bearer(token)).expect(200);
    expect(s.body.reminderTemplate).toContain('{student}');
    const t = await api().patch('/api/v1/admin/settings').set(bearer(token)).send({ reminderTemplate: 'Hi, {student} owes {amount}.' }).expect(200);
    expect(t.body.reminderTemplate).toBe('Hi, {student} owes {amount}.');

    const r = await api().post('/api/v1/admin/fee-reminders').set(bearer(token)).send({ studentId: String(student._id), months: ['2026-09'], amount: 800, phone: '97481 33102' }).expect(201);
    expect(r.body).toMatchObject({ months: ['2026-09'], amount: 800, phone: '+919748133102' });
    await api().post('/api/v1/admin/fee-reminders').set(bearer(token)).send({ studentId: '0123456789abcdef01234567', phone: '9748133102' }).expect(404);

    const list = await api().get('/api/v1/admin/fee-reminders').set(bearer(token)).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].studentId).toBe(String(student._id));
    await api().get('/api/v1/admin/fee-reminders').expect(401);
  });
});
