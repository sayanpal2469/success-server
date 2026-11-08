import { describe, expect, it } from 'vitest';

import { addDays, todayIST } from '../src/lib/time.js';
import { Payment } from '../src/models/students.js';
import { adminToken, api, bearer, makeStudent, useDb } from './helpers.js';

useDb();

describe('partial payments', () => {
  it('pays a month in parts: what is left stays due / overdue until it is paid', async () => {
    const admin = await adminToken();
    // Admitted two months back, so last month is overdue.
    const { student, token } = await makeStudent({ admissionDate: addDays(todayIST(), -40) });
    const id = String(student._id);
    const fees0 = (await api().get('/api/v1/student/fees').set(bearer(token)).expect(200)).body;
    const first = fees0.months[0];
    const fee = first.total as number;
    expect(first).toMatchObject({ status: 'OVERDUE', amount: fee, paid: 0, partial: false });

    // Pay part of the first month.
    const part = Math.floor(fee / 2);
    const p1 = await api().post('/api/v1/admin/payments').set(bearer(admin)).send({ studentId: id, allocations: [{ month: first.key, amount: part }], method: 'Cash' }).expect(201);
    expect(p1.body).toMatchObject({ amount: part, partial: true, months: [first.key] });

    let fees = (await api().get('/api/v1/student/fees').set(bearer(token)).expect(200)).body;
    expect(fees.months[0]).toMatchObject({ key: first.key, status: 'OVERDUE', amount: fee - part, paid: part, partial: true, receiptNo: p1.body.receiptNo });
    expect(fees.receipts[0]).toMatchObject({ partial: true, amount: part });
    expect(fees.summary.paid).toBe(part);

    // The admin's student list sees the same.
    const list = (await api().get(`/api/v1/admin/students?q=${student.studentId}`).set(bearer(admin)).expect(200)).body.data[0];
    expect(list.fees.status).toBe('OVERDUE');

    // More than what is left is refused; the rest settles the month.
    await api().post('/api/v1/admin/payments').set(bearer(admin)).send({ studentId: id, allocations: [{ month: first.key, amount: fee - part + 1 }], method: 'UPI' }).expect(400);
    const p2 = await api().post('/api/v1/admin/payments').set(bearer(admin)).send({ studentId: id, allocations: [{ month: first.key, amount: fee - part }], method: 'UPI' }).expect(201);
    expect(p2.body.partial).toBe(false);
    fees = (await api().get('/api/v1/student/fees').set(bearer(token)).expect(200)).body;
    expect(fees.months[0]).toMatchObject({ status: 'PAID', amount: fee, paid: fee, partial: false });
    await api().post('/api/v1/admin/payments').set(bearer(admin)).send({ studentId: id, months: [first.key], method: 'Cash' }).expect(409);

    // An amount for several months is spread oldest first.
    const rest = fees.months.slice(1).map((m: { key: string }) => m.key);
    if (rest.length) {
      const p3 = await api().post('/api/v1/admin/payments').set(bearer(admin)).send({ studentId: id, months: rest, amount: 100, method: 'Cash' }).expect(201);
      expect(p3.body.allocations).toEqual([{ month: rest[0], amount: 100 }]);
      expect(p3.body.partial).toBe(true);
    }

    // Removing a part payment makes that part due again.
    await api().delete(`/api/v1/admin/payments/${p2.body.id}`).set(bearer(admin)).send({ reason: 'Entered twice' }).expect(200);
    fees = (await api().get('/api/v1/student/fees').set(bearer(token)).expect(200)).body;
    expect(fees.months[0]).toMatchObject({ status: 'OVERDUE', amount: fee - part, partial: true });
  });

  it('payments made before partial payments still count as paid in full', async () => {
    const { student, token } = await makeStudent({ admissionDate: addDays(todayIST(), -5) });
    const m = todayIST().slice(0, 7);
    const first = addDays(todayIST(), -5).slice(0, 7);
    const months = [...new Set([first, m])];
    // Old shape: no allocations, an amount below today's fee.
    await Payment.create({ receiptNo: 'ST/26-27/08001', student: student._id, months, amount: 10, method: 'Cash', receivedAt: new Date(), receivedBy: 'Admin' });
    const fees = (await api().get('/api/v1/student/fees').set(bearer(token)).expect(200)).body;
    expect(fees.months.every((x: { status: string }) => x.status === 'PAID')).toBe(true);
  });
});
