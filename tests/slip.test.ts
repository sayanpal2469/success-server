import { describe, expect, it } from 'vitest';

import { adminToken, api, bearer, useDb } from './helpers.js';

useDb();

describe('admission slip fields', () => {
  it('stores roll, address and last year result; rules are editable', async () => {
    const token = await adminToken();
    const r = await api()
      .post('/api/v1/admin/students')
      .set(bearer(token))
      .send({
        name: 'Kabita Ghosh',
        email: 'kabita@test.in',
        classId: 'c11',
        phone: '9609853821',
        gender: 'Female',
        dob: '2010-04-02',
        aadhaar: '123412341234',
        fatherName: 'Father',
        motherName: 'Mother',
        guardianPhone: '9609853820',
        subjectIds: ['c11-physics', 'c11-english'],
        roll: '31',
        address: 'Chadul, Munshirhat, Howrah',
        previousResult: { className: 'Class 10', marks: [{ subject: 'Beng', marks: '30' }, { subject: 'Eng', marks: '32' }], total: '207' },
      })
      .expect(201);
    expect(r.body.student).toMatchObject({ roll: '31', address: 'Chadul, Munshirhat, Howrah', previousResult: { className: 'Class 10', total: '207' } });
    expect(r.body.student.previousResult.marks).toEqual([{ subject: 'Beng', marks: '30' }, { subject: 'Eng', marks: '32' }]);

    // The student downloads the same slip / form from the app.
    const login = await api().post('/api/v1/auth/student/login').send({ studentId: r.body.student.studentId, password: r.body.tempPassword }).expect(200);
    const docs = await api().get('/api/v1/student/documents').set(bearer(login.body.accessToken)).expect(200);
    expect(docs.body.student).toMatchObject({ roll: '31', address: 'Chadul, Munshirhat, Howrah', previousResult: { total: '207' } });
    expect(docs.body.institute).toMatchObject({ name: 'Success Tutorials', phone: '6296264592' });
    expect(docs.body.rules[1]).toContain(String(docs.body.student.fee.admissionFee));
    expect(docs.body.rules.join(' ')).not.toMatch(/\{[a-zA-Z]+\}/);

    const p = await api().patch(`/api/v1/admin/students/${r.body.student.id}`).set(bearer(token)).send({ roll: '12' }).expect(200);
    expect(p.body.roll).toBe('12');
    expect(p.body.previousResult.total).toBe('207');

    const s = await api().get('/api/v1/admin/settings').set(bearer(token)).expect(200);
    expect(s.body.admissionRules).toHaveLength(6);
    const u = await api().patch('/api/v1/admin/settings').set(bearer(token)).send({ admissionRules: ['Rule one {admissionFee}'], tagline: 'Hello' }).expect(200);
    expect(u.body).toMatchObject({ admissionRules: ['Rule one {admissionFee}'], tagline: 'Hello' });
  });
});
