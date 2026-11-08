import { describe, expect, it } from 'vitest';

import { ADMIN, api, bearer, makeStudent, useDb } from './helpers.js';

useDb();

describe('admin auth', () => {
  it('signs in with email + password and reaches admin routes', async () => {
    const r = await api().post('/api/v1/auth/admin/login').send({ email: ADMIN.email.toUpperCase(), password: ADMIN.password }).expect(200);
    expect(r.body.admin.email).toBe(ADMIN.email);
    expect(r.body.accessToken).toBeTypeOf('string');
    await api().get('/api/v1/admin/me').set(bearer(r.body.accessToken)).expect(200);
  });

  it('rejects a wrong password and a missing token', async () => {
    const r = await api().post('/api/v1/auth/admin/login').send({ email: ADMIN.email, password: 'nope' }).expect(401);
    expect(r.body.error.code).toBe('UNAUTHORIZED');
    await api().get('/api/v1/admin/students').expect(401);
  });

  it('rotates refresh tokens and revokes the login when an old one is reused', async () => {
    const login = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
    const first = login.body.refreshToken;
    const r1 = await api().post('/api/v1/auth/refresh').send({ refreshToken: first }).expect(200);
    expect(r1.body.refreshToken).not.toBe(first);
    // replaying the first token = theft → whole family revoked, including the new token
    await api().post('/api/v1/auth/refresh').send({ refreshToken: first }).expect(401);
    await api().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
  });

  it('logout ends the session', async () => {
    const login = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
    await api().post('/api/v1/auth/logout').send({ refreshToken: login.body.refreshToken }).expect(204);
    await api().post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401);
  });
});

describe('student auth', () => {
  it('signs in with Student ID (any case) + password; tokens are not interchangeable', async () => {
    const { student, token } = await makeStudent();
    const r = await api().post('/api/v1/auth/student/login').send({ studentId: student.studentId.toLowerCase(), password: 'pass1234' }).expect(200);
    expect(r.body.student.studentId).toBe(student.studentId);
    expect(r.body.student.aadhaar).toBe('XXXX XXXX 1234');
    await api().get('/api/v1/student/me').set(bearer(token)).expect(200);
    await api().get('/api/v1/admin/me').set(bearer(token)).expect(401);
  });

  it('blocks inactive students', async () => {
    const { student, token } = await makeStudent();
    student.status = 'INACTIVE';
    await student.save();
    await api().get('/api/v1/student/me').set(bearer(token)).expect(403);
    await api().post('/api/v1/auth/student/login').send({ studentId: student.studentId, password: 'pass1234' }).expect(403);
  });

  it('changing the password signs out other devices', async () => {
    const { student, token } = await makeStudent();
    const other = await api().post('/api/v1/auth/student/login').send({ studentId: student.studentId, password: 'pass1234' }).expect(200);
    await api().put('/api/v1/student/password').set(bearer(token)).send({ current: 'wrong', next: 'newpass1' }).expect(401);
    await api().put('/api/v1/student/password').set(bearer(token)).send({ current: 'pass1234', next: 'newpass1' }).expect(204);
    await api().post('/api/v1/auth/refresh').send({ refreshToken: other.body.refreshToken }).expect(401);
    await api().post('/api/v1/auth/student/login').send({ studentId: student.studentId, password: 'newpass1' }).expect(200);
  });
});
