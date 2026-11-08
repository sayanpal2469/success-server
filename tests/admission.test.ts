import { describe, expect, it } from 'vitest';

import { todayIST } from '../src/lib/time.js';
import { adminToken, api, bearer, useDb } from './helpers.js';

useDb();

const form = {
  name: 'Ritika Bose',
  email: 'ritika@test.in',
  classId: 'c10',
  phone: '98300 12345',
  gender: 'Female',
  dob: '2011-05-02',
  aadhaar: '2345 6789 0123',
  fatherName: 'Amit Bose',
  motherName: 'Rina Bose',
  guardianPhone: '9748133102',
  school: 'Howrah Zilla School',
  board: 'WBBSE',
  targetExams: ['Madhyamik'],
  subjectIds: ['c10-mathematics', 'c10-english'],
  extras: ['spoken'],
};

describe('admission request from the app', () => {
  it('apply → status → approve → sign in with the chosen password', async () => {
    const cat = await api().get('/api/v1/public/catalog').expect(200);
    expect(cat.body.classes.find((c: { id: string }) => c.id === 'c10').subjects.length).toBe(7);

    const applied = await api()
      .post('/api/v1/public/admissions')
      .send({ ...form, password: 'mypass1' })
      .expect(201);
    expect(applied.body.ref).toMatch(/^REQ-\d{2}-0001$/);
    // Maths 450 + English 350 + Spoken English 500
    expect(applied.body.monthlyFee.monthly).toBe(1300);

    const st = await api().post('/api/v1/public/admissions/status').send({ ref: applied.body.ref, phone: '+919830012345' }).expect(200);
    expect(st.body.status).toBe('PENDING');
    await api().post('/api/v1/public/admissions/status').send({ ref: applied.body.ref, phone: '9000000000' }).expect(404);

    const token = await adminToken();
    const list = await api().get('/api/v1/admin/applications').set(bearer(token)).expect(200);
    expect(list.body.meta.counts.PENDING).toBe(1);
    const appId = list.body.data[0].id;
    expect(list.body.data[0].passwordHash).toBeUndefined();

    const ok = await api()
      .post(`/api/v1/admin/applications/${appId}/approve`)
      .set(bearer(token))
      .send({ email: 'ritika@test.in', batch: 'Morning', discount: 100, discountReason: 'Sibling', firstPayment: { method: 'Cash' } })
      .expect(201);
    expect(ok.body.student.studentId).toMatch(/^ST26-\d{4}$/);
    expect(ok.body.student.fee.monthly).toBe(1200);
    // first month + admission fee (200)
    expect(ok.body.payment.amount).toBe(1400);
    expect(ok.body.payment.months).toEqual([todayIST().slice(0, 7)]);

    await api().post(`/api/v1/admin/applications/${appId}/approve`).set(bearer(token)).send({}).expect(409);

    const after = await api().post('/api/v1/public/admissions/status').send({ ref: applied.body.ref, phone: '9830012345' }).expect(200);
    expect(after.body.status).toBe('APPROVED');
    expect(after.body.studentId).toBe(ok.body.student.studentId);

    const login = await api().post('/api/v1/auth/student/login').send({ studentId: after.body.studentId, password: 'mypass1' }).expect(200);
    const fees = await api().get('/api/v1/student/fees').set(bearer(login.body.accessToken)).expect(200);
    expect(fees.body.summary.status).toBe('PAID');
  });

  it('reject needs a reason that the applicant then sees', async () => {
    const applied = await api()
      .post('/api/v1/public/admissions')
      .send({ ...form, email: 'rejected@test.in', phone: '9830099999', password: 'mypass1' })
      .expect(201);
    const token = await adminToken();
    const list = await api().get('/api/v1/admin/applications?q=' + applied.body.ref).set(bearer(token)).expect(200);
    const id = list.body.data[0].id;
    await api().post(`/api/v1/admin/applications/${id}/reject`).set(bearer(token)).send({ reason: '' }).expect(400);
    await api().post(`/api/v1/admin/applications/${id}/reject`).set(bearer(token)).send({ reason: 'Batch full' }).expect(200);
    const st = await api().post('/api/v1/public/admissions/status').send({ ref: applied.body.ref, phone: '9830099999' }).expect(200);
    expect(st.body).toMatchObject({ status: 'REJECTED', rejectReason: 'Batch full' });
  });

  it('validates the form and the class catalog', async () => {
    const bad = await api()
      .post('/api/v1/public/admissions')
      .send({ ...form, aadhaar: '12', password: 'x' })
      .expect(400);
    expect(bad.body.error.details.fields.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(['aadhaar', 'password']));
    const r = await api()
      .post('/api/v1/public/admissions')
      .send({ ...form, subjectIds: ['c12-physics'], password: 'mypass1' })
      .expect(400);
    expect(r.body.error.message).toMatch(/not offered/);
  });

  it('closed admission refuses new requests', async () => {
    const token = await adminToken();
    await api().patch('/api/v1/admin/settings').set(bearer(token)).send({ admissionOpen: false }).expect(200);
    const r = await api()
      .post('/api/v1/public/admissions')
      .send({ ...form, password: 'mypass1' })
      .expect(422);
    expect(r.body.error.code).toBe('ADMISSION_CLOSED');
    await api().patch('/api/v1/admin/settings').set(bearer(token)).send({ admissionOpen: true }).expect(200);
  });
});

describe('office admission', () => {
  it('creates the student with a temporary password and sequential IDs', async () => {
    const token = await adminToken();
    const a = await api()
      .post('/api/v1/admin/students')
      .set(bearer(token))
      .send({ ...form, email: 'a1@test.in', phone: '9830011111', batch: 'Evening', durationMonths: 6 })
      .expect(201);
    expect(a.body.tempPassword).toHaveLength(8);
    expect(a.body.student.passwordHash).toBeUndefined();
    const b = await api()
      .post('/api/v1/admin/students')
      .set(bearer(token))
      .send({ ...form, email: 'b1@test.in', phone: '9830022222', batch: 'Morning', password: 'given1' })
      .expect(201);
    expect(b.body.tempPassword).toBeUndefined();
    const na = Number(a.body.student.studentId.slice(5));
    expect(Number(b.body.student.studentId.slice(5))).toBe(na + 1);
    await api().post('/api/v1/auth/student/login').send({ studentId: a.body.student.studentId, password: a.body.tempPassword }).expect(200);

    // unknown batch is refused
    await api()
      .post('/api/v1/admin/students')
      .set(bearer(token))
      .send({ ...form, email: 'c1@test.in', batch: 'Night' })
      .expect(400);

    const reset = await api().post(`/api/v1/admin/students/${b.body.student.id}/reset-password`).set(bearer(token)).send({}).expect(200);
    await api().post('/api/v1/auth/student/login').send({ studentId: b.body.student.studentId, password: 'given1' }).expect(401);
    await api().post('/api/v1/auth/student/login').send({ studentId: b.body.student.studentId, password: reset.body.password }).expect(200);
  });

  it('PATCH changes only the fields sent (defaults never reset others)', async () => {
    const token = await adminToken();
    const a = await api()
      .post('/api/v1/admin/students')
      .set(bearer(token))
      .send({ ...form, email: 'd1@test.in', phone: '9830033333', batch: 'Morning', discount: 100 })
      .expect(201);
    const p = await api().patch(`/api/v1/admin/students/${a.body.student.id}`).set(bearer(token)).send({ school: 'New School' }).expect(200);
    expect(p.body).toMatchObject({ school: 'New School', batch: 'Morning', discount: 100, subjectIds: form.subjectIds, extras: form.extras, board: 'WBBSE' });
    await api().patch(`/api/v1/admin/students/${a.body.student.id}`).set(bearer(token)).send({ studentId: 'HACK' }).expect(400);
  });
});
