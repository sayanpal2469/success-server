import { describe, expect, it } from 'vitest';

import { ClassDef } from '../src/models/catalog.js';
import { Teacher } from '../src/models/content.js';
import { adminToken, api, bearer, useDb } from './helpers.js';

useDb();

describe('teachers', () => {
  it('adds teachers with IDs and class subjects; the website sees only best teachers’ public fields', async () => {
    const admin = await adminToken();
    const [s1, s2] = (await ClassDef.findById('c10').lean())!.subjects.map((s) => s.name);

    // A teacher added before IDs existed gets one when the list loads.
    await Teacher.create({ name: 'Old Profile', subject: 'Physics', visible: true, order: 1 });

    const a = await api()
      .post('/api/v1/admin/teachers')
      .set(bearer(admin))
      .send({ name: 'Anirban Ghosh', phone: '98300 12345', email: 'Anirban@Test.in', joined: '2024-06-01', visible: false, assignments: [{ groupId: 'c10', subject: s1 }, { groupId: 'c10', subject: s2 }, { groupId: 'c10', subject: s1 }, { groupId: 'spoken', subject: 'Spoken English' }] })
      .expect(201);
    expect(a.body).toMatchObject({ name: 'Anirban Ghosh', phone: '+919830012345', email: 'anirban@test.in', visible: false });
    expect(a.body.code).toMatch(/^TR-\d{3}$/);
    expect(a.body.assignments).toHaveLength(3);

    await api().post('/api/v1/admin/teachers').set(bearer(admin)).send({ name: 'X', assignments: [{ groupId: 'c10', subject: 'Astrology' }] }).expect(400);
    await api().post('/api/v1/admin/teachers').set(bearer(admin)).send({ name: 'X', phone: '12345' }).expect(400);

    const list = (await api().get('/api/v1/admin/teachers').set(bearer(admin)).expect(200)).body;
    expect(list).toHaveLength(2);
    expect(new Set(list.map((t: { code: string }) => t.code)).size).toBe(2);
    expect(list.every((t: { code?: string }) => /^TR-\d{3}$/.test(t.code ?? ''))).toBe(true);

    // Edit: change subjects, then make them a best teacher.
    await api().patch(`/api/v1/admin/teachers/${a.body.id}`).set(bearer(admin)).send({ assignments: [{ groupId: 'c10', subject: 'Astrology' }] }).expect(400);
    const e = await api().patch(`/api/v1/admin/teachers/${a.body.id}`).set(bearer(admin)).send({ assignments: [{ groupId: 'c10', subject: s2 }], visible: true }).expect(200);
    expect(e.body.assignments).toEqual([{ groupId: 'c10', subject: s2 }]);
    expect(e.body.code).toBe(a.body.code);

    const pub = (await api().get('/api/v1/public/teachers').expect(200)).body;
    expect(pub).toHaveLength(2);
    const p = pub.find((t: { name: string }) => t.name === 'Anirban Ghosh');
    expect(p).toMatchObject({ subject: s2 });
    expect(p.phone).toBeUndefined();
    expect(p.email).toBeUndefined();

    // Optional Aadhaar scans: private, signed links in the panel, never on the website.
    const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
    const up = (await api().post('/api/v1/admin/uploads/doc').set(bearer(admin)).attach('file', JPG, { filename: 'aadhaar.jpg', contentType: 'image/jpeg' }).expect(201)).body.url as string;
    expect(up).toMatch(/^\/files\//);
    await api().patch(`/api/v1/admin/teachers/${a.body.id}`).set(bearer(admin)).send({ aadhaarFront: 'https://evil.example/x.jpg' }).expect(400);
    const withDoc = await api().patch(`/api/v1/admin/teachers/${a.body.id}`).set(bearer(admin)).send({ aadhaarFront: up }).expect(200);
    expect(withDoc.body.aadhaarFront).toMatch(/^\/files\/.+\?exp=\d+&sig=/);
    expect(withDoc.body.aadhaarBack).toBeUndefined();
    // The signed link sent back unchanged is stored as the plain file.
    await api().patch(`/api/v1/admin/teachers/${a.body.id}`).set(bearer(admin)).send({ aadhaarFront: withDoc.body.aadhaarFront }).expect(200);
    expect((await Teacher.findById(a.body.id).lean())!.aadhaarFront).toBe(up);
    expect(JSON.stringify((await api().get('/api/v1/public/teachers').expect(200)).body)).not.toContain('/files/');
    await api().patch(`/api/v1/admin/teachers/${a.body.id}`).set(bearer(admin)).send({ aadhaarFront: '' }).expect(200);
    expect((await Teacher.findById(a.body.id).lean())!.aadhaarFront).toBeUndefined();

    await api().delete(`/api/v1/admin/teachers/${a.body.id}`).set(bearer(admin)).expect(204);
    expect((await api().get('/api/v1/public/teachers').expect(200)).body).toHaveLength(1);
  });
});
