import { describe, expect, it } from 'vitest';

import { monthsBetween, todayIST, addDays } from '../src/lib/time.js';
import { adminToken, api, bearer, makeStudent, useDb } from './helpers.js';

useDb();

describe('fees and payments', () => {
  it('ledger: monthly = subjects − discount, admission fee in the first month, overdue after due day', async () => {
    const admissionDate = addDays(todayIST(), -70);
    const { student, token } = await makeStudent({ admissionDate, discount: 50 });
    const months = monthsBetween(admissionDate, todayIST());
    const f = await api().get('/api/v1/student/fees').set(bearer(token)).expect(200);
    // Bengali 250 + Maths 450 − 50
    expect(f.body.breakdown.monthly).toBe(650);
    expect(f.body.months.map((m: { key: string }) => m.key)).toEqual(months);
    expect(f.body.months[0].amount).toBe(650 + 200);
    expect(f.body.summary.status).toBe('OVERDUE');

    const admin = await adminToken();
    const pay = await api()
      .post('/api/v1/admin/payments')
      .set(bearer(admin))
      .send({ studentId: String(student._id), months: months.slice(0, 2), method: 'UPI', reference: 'UTR1' })
      .expect(201);
    expect(pay.body.amount).toBe(850 + 650);
    expect(pay.body.receiptNo).toMatch(/^ST\/\d{2}-\d{2}\/00001$/);

    // the same month can't be paid twice
    const dup = await api().post('/api/v1/admin/payments').set(bearer(admin)).send({ studentId: String(student._id), months: [months[1]], method: 'Cash' }).expect(409);
    expect(dup.body.error.details.months).toEqual([months[1]]);
    // months outside the enrolment are refused
    await api().post('/api/v1/admin/payments').set(bearer(admin)).send({ studentId: String(student._id), months: ['2020-01'], method: 'Cash' }).expect(400);

    const after = await api().get('/api/v1/student/fees').set(bearer(token)).expect(200);
    expect(after.body.months.slice(0, 2).every((m: { status: string }) => m.status === 'PAID')).toBe(true);
    expect(after.body.receipts).toHaveLength(1);
    const receipt = await api().get(`/api/v1/student/receipts/${pay.body.id}`).set(bearer(token)).expect(200);
    expect(receipt.body.student.studentId).toBe(student.studentId);

    // another student cannot read it
    const other = await makeStudent();
    await api().get(`/api/v1/student/receipts/${pay.body.id}`).set(bearer(other.token)).expect(404);

    // removing a mistaken entry frees the months again
    await api().delete(`/api/v1/admin/payments/${pay.body.id}`).set(bearer(admin)).send({ reason: 'Wrong student' }).expect(200);
    await api().post('/api/v1/admin/payments').set(bearer(admin)).send({ studentId: String(student._id), months: [months[1]], method: 'Cash' }).expect(201);
  });

  it('concurrent payments for the same month: exactly one wins', async () => {
    const { student } = await makeStudent();
    const admin = await adminToken();
    const m = todayIST().slice(0, 7);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => api().post('/api/v1/admin/payments').set(bearer(admin)).send({ studentId: String(student._id), months: [m], method: 'Cash' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  });

  it('student list shows fee status and filters pending fees', async () => {
    const admin = await adminToken();
    const r = await api().get('/api/v1/admin/students?fee=OVERDUE&classId=c10').set(bearer(admin)).expect(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    expect(r.body.data.every((s: { fees: { status: string } }) => s.fees.status === 'OVERDUE')).toBe(true);
    const dash = await api().get('/api/v1/admin/dashboard').set(bearer(admin)).expect(200);
    expect(dash.body.kpis.feesPending).toBeGreaterThan(0);
    expect(dash.body.collection).toHaveLength(6);
  });
});
