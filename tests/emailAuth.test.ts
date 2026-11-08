import { describe, expect, it } from 'vitest';

import { outbox } from '../src/lib/mail.js';
import { ResetCode } from '../src/models/org.js';
import { ADMIN, adminToken, api, bearer, useDb } from './helpers.js';

useDb();

const form = {
  name: 'Payel Das',
  classId: 'c10',
  phone: '98300 44444',
  gender: 'Female',
  dob: '2011-05-02',
  aadhaar: '2345 6789 0123',
  fatherName: 'Amit Das',
  motherName: 'Rina Das',
  guardianPhone: '9748133102',
  school: 'Howrah Zilla School',
  board: 'WBBSE',
  subjectIds: ['c10-mathematics', 'c10-english'],
  batch: 'Morning',
};

const codeIn = (html: string) => /(\d{6}) is your/.exec(html)?.[1] ?? '';

describe('email sign-in, welcome email and forgot password', () => {
  it('admits with an email, emails the password, signs in by email and resets with a code', async () => {
    const admin = await adminToken();
    outbox.length = 0;

    // Email is required and unique.
    await api().post('/api/v1/admin/students').set(bearer(admin)).send(form).expect(400);
    const r = await api().post('/api/v1/admin/students').set(bearer(admin)).send({ ...form, email: 'Payel.Das@Gmail.com' }).expect(201);
    expect(r.body.emailed).toBe(true);
    await api().post('/api/v1/admin/students').set(bearer(admin)).send({ ...form, phone: '9830055555', email: 'payel.das@gmail.com' }).expect(409);

    // Welcome email: logo, login email and the generated password.
    const welcome = outbox.find((m) => m.to === 'payel.das@gmail.com')!;
    expect(welcome.subject).toMatch(/Welcome/);
    expect(welcome.html).toContain('cid:logo');
    expect(welcome.html).toContain(r.body.tempPassword);
    expect(welcome.text).toContain(r.body.student.studentId);

    // Sign in with the email (any case), or the Student ID, or the old `studentId` field.
    await api().post('/api/v1/auth/student/login').send({ login: 'PAYEL.DAS@gmail.com', password: r.body.tempPassword }).expect(200);
    await api().post('/api/v1/auth/student/login').send({ login: r.body.student.studentId, password: r.body.tempPassword }).expect(200);
    await api().post('/api/v1/auth/student/login').send({ studentId: r.body.student.studentId, password: r.body.tempPassword }).expect(200);
    await api().post('/api/v1/auth/student/login').send({ login: 'payel.das@gmail.com', password: 'nope' }).expect(401);

    // Forgot password: unknown emails get the same answer and no email.
    outbox.length = 0;
    await api().post('/api/v1/auth/student/forgot').send({ email: 'nobody@gmail.com' }).expect(200);
    expect(outbox).toHaveLength(0);
    await api().post('/api/v1/auth/student/forgot').send({ email: 'payel.das@gmail.com' }).expect(200);
    expect(outbox).toHaveLength(1);
    const code = codeIn(outbox[0]!.subject);
    expect(code).toMatch(/^\d{6}$/);
    expect(outbox[0]!.html).toContain('cid:logo');
    // The code is stored hashed, never as typed.
    const row = await ResetCode.findOne().lean();
    expect(row!.codeHash).not.toContain(code);
    // Asking again within a minute sends nothing new.
    await api().post('/api/v1/auth/student/forgot').send({ email: 'payel.das@gmail.com' }).expect(200);
    expect(outbox).toHaveLength(1);

    const wrong = code === '000000' ? '111111' : '000000';
    await api().post('/api/v1/auth/student/reset').send({ email: 'payel.das@gmail.com', code: wrong, password: 'newpass1' }).expect(400);
    await api().post('/api/v1/auth/student/reset').send({ email: 'payel.das@gmail.com', code: '12', password: 'newpass1' }).expect(400);
    await api().post('/api/v1/auth/student/reset').send({ email: 'payel.das@gmail.com', code, password: 'newpass1' }).expect(204);
    // Used once only.
    await api().post('/api/v1/auth/student/reset').send({ email: 'payel.das@gmail.com', code, password: 'other12' }).expect(400);
    await api().post('/api/v1/auth/student/login').send({ login: 'payel.das@gmail.com', password: r.body.tempPassword }).expect(401);
    await api().post('/api/v1/auth/student/login').send({ login: 'payel.das@gmail.com', password: 'newpass1' }).expect(200);

    // The office resets the password: it is emailed too.
    outbox.length = 0;
    const reset = await api().post(`/api/v1/admin/students/${r.body.student.id}/reset-password`).set(bearer(admin)).send({}).expect(200);
    expect(reset.body).toMatchObject({ emailed: true, email: 'payel.das@gmail.com' });
    expect(outbox[0]!.html).toContain(reset.body.password);
  });

  it('five wrong codes end the code', async () => {
    const admin = await adminToken();
    await api().post('/api/v1/admin/students').set(bearer(admin)).send({ ...form, phone: '9830066666', email: 'five@test.in' }).expect(201);
    outbox.length = 0;
    await api().post('/api/v1/auth/student/forgot').send({ email: 'five@test.in' }).expect(200);
    const code = codeIn(outbox[0]!.subject);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await api().post('/api/v1/auth/student/reset').send({ email: 'five@test.in', code: wrong, password: 'newpass1' }).expect(400);
    await api().post('/api/v1/auth/student/reset').send({ email: 'five@test.in', code, password: 'newpass1' }).expect(400);
  });

  it('admin forgot password', async () => {
    outbox.length = 0;
    await api().post('/api/v1/auth/admin/forgot').send({ email: ADMIN.email }).expect(200);
    const code = codeIn(outbox[0]!.subject);
    expect(outbox[0]!.to).toBe(ADMIN.email);
    await api().post('/api/v1/auth/admin/reset').send({ email: ADMIN.email, code, password: 'short' }).expect(400);
    await api().post('/api/v1/auth/admin/reset').send({ email: ADMIN.email, code, password: 'Brand-new-1' }).expect(204);
    await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(401);
    await api().post('/api/v1/auth/admin/login').send({ email: ADMIN.email, password: 'Brand-new-1' }).expect(200);
  });
});
