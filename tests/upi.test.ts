import { describe, expect, it } from 'vitest';

import { adminToken, api, bearer, makeStudent, useDb } from './helpers.js';

useDb();

describe('UPI payment details', () => {
  it('the office sets UPI ID / QR, and the app gets them only when turned on', async () => {
    const admin = await adminToken();
    const { token } = await makeStudent();

    // Off by default.
    expect((await api().get('/api/v1/student/fees').set(bearer(token)).expect(200)).body.upi).toBeNull();

    // Bad UPI IDs, and turning it on without an ID, are refused.
    await api().patch('/api/v1/admin/settings').set(bearer(admin)).send({ upi: { enabled: false, id: 'not a upi', name: '', qrImage: '', note: '' } }).expect(400);
    await api().patch('/api/v1/admin/settings').set(bearer(admin)).send({ upi: { enabled: true, id: '', name: '', qrImage: '', note: '' } }).expect(400);
    await api().patch('/api/v1/admin/settings').set(bearer(admin)).send({ upi: { enabled: true, id: 'success@okaxis', name: '', qrImage: 'javascript:alert(1)', note: '' } }).expect(400);

    // Saved but hidden: still nothing in the app.
    await api().patch('/api/v1/admin/settings').set(bearer(admin)).send({ upi: { enabled: false, id: 'success@okaxis', name: 'Success Tutorials', qrImage: '', note: '' } }).expect(200);
    expect((await api().get('/api/v1/student/fees').set(bearer(token)).expect(200)).body.upi).toBeNull();

    const on = await api()
      .patch('/api/v1/admin/settings')
      .set(bearer(admin))
      .send({ upi: { enabled: true, id: 'success.tutorials@okaxis', name: 'Srijit Saha', qrImage: '/uploads/0123456789abcdef0123456789abcdef.png', note: 'Write your Student ID in the note.' } })
      .expect(200);
    expect(on.body.upi).toMatchObject({ enabled: true, id: 'success.tutorials@okaxis' });
    const fees = await api().get('/api/v1/student/fees').set(bearer(token)).expect(200);
    expect(fees.body.upi).toEqual({ id: 'success.tutorials@okaxis', name: 'Srijit Saha', qrImage: '/uploads/0123456789abcdef0123456789abcdef.png', note: 'Write your Student ID in the note.' });

    // Other settings are left alone.
    expect((await api().get('/api/v1/admin/settings').set(bearer(admin)).expect(200)).body.dueDay).toBe(10);
  });
});
