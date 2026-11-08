import { describe, expect, it } from 'vitest';

import { Course } from '../src/models/content.js';
import { adminToken, api, bearer, useDb } from './helpers.js';

useDb();

describe('website enquiries', () => {
  it('class-wise and course enquiries reach the admin panel', async () => {
    const course = await Course.create({
      title: 'WBJEE Crash Course',
      published: true,
      access: { classes: ['c12'] },
      modules: [{ title: 'Physics', lessons: [{ title: 'Kinematics', kind: 'VIDEO', source: 'YOUTUBE', url: 'https://youtu.be/abc' }, { title: 'Notes', kind: 'PDF', source: 'UPLOAD', url: '/uploads/n.pdf' }] }],
    });
    await Course.create({ title: 'Hidden draft', published: false });

    const courses = await api().get('/api/v1/public/courses').expect(200);
    expect(courses.body.map((c: { title: string }) => c.title)).toEqual(['WBJEE Crash Course']);
    expect(courses.body[0]).toMatchObject({ classIds: ['c12'], classNames: ['Class 12'], lessonCount: 2, videoCount: 1, pdfCount: 1 });
    expect(courses.body[0].modules[0].lessons[0]).toEqual({ title: 'Kinematics', kind: 'VIDEO', freePreview: false });

    await api()
      .post('/api/v1/public/enquiries')
      .send({ name: 'Riya Das', phone: '98300 11111', classId: 'c10', subjectIds: ['c10-mathematics', 'c10-english'], extras: ['spoken'], message: 'Evening batch?', utm: { utm_source: 'facebook' } })
      .expect(201);
    await api().post('/api/v1/public/enquiries').send({ name: 'Arka Sen', phone: '9830022222', courseId: String(course._id) }).expect(201);
    await api().post('/api/v1/public/enquiries').send({ kind: 'DEMO', name: 'Puja Kar', phone: '9830033333', classId: 'c11', slot: 'Saturday · 10:00 – 11:00 AM' }).expect(201);

    // Subjects of another class, unknown class and unpublished course are refused.
    await api().post('/api/v1/public/enquiries').send({ name: 'X Y', phone: '9830044444', classId: 'c10', subjectIds: ['c12-physics'] }).expect(400);
    await api().post('/api/v1/public/enquiries').send({ name: 'X Y', phone: '9830044444', classId: 'zz' }).expect(400);
    const draft = await Course.findOne({ published: false });
    await api().post('/api/v1/public/enquiries').send({ name: 'X Y', phone: '9830044444', courseId: String(draft!._id) }).expect(400);
    // Honeypot: accepted, not stored.
    await api().post('/api/v1/public/enquiries').send({ name: 'Bot', phone: '9830055555', website: 'spam.example' }).expect(201);

    const token = await adminToken();
    const list = await api().get('/api/v1/admin/enquiries').set(bearer(token)).expect(200);
    expect(list.body).toHaveLength(3);
    const riya = list.body.find((e: { name: string }) => e.name === 'Riya Das');
    expect(riya).toMatchObject({ kind: 'ENQUIRY', phone: '+919830011111', classId: 'c10', subjectIds: ['c10-mathematics', 'c10-english'], extras: ['spoken'], status: 'NEW', utm: { utm_source: 'facebook' } });
    expect(list.body.find((e: { name: string }) => e.name === 'Arka Sen').courseTitle).toBe('WBJEE Crash Course');
    expect(list.body.find((e: { name: string }) => e.name === 'Puja Kar').kind).toBe('DEMO');

    const done = await api().patch(`/api/v1/admin/enquiries/${riya.id}`).set(bearer(token)).send({ status: 'CONTACTED', note: 'Called, coming Saturday' }).expect(200);
    expect(done.body).toMatchObject({ status: 'CONTACTED', note: 'Called, coming Saturday' });
    expect(done.body.contactedAt).toBeTruthy();

    await api().delete(`/api/v1/admin/enquiries/${riya.id}`).set(bearer(token)).expect(204);
    expect((await api().get('/api/v1/admin/enquiries').set(bearer(token)).expect(200)).body).toHaveLength(2);
    await api().get('/api/v1/admin/enquiries').expect(401);
  });

  it('admission requests from the website are marked as such', async () => {
    const r = await api()
      .post('/api/v1/public/admissions')
      .send({ name: 'Web Applicant', email: 'web@test.in', classId: 'c10', phone: '9830066666', gender: 'Male', dob: '2011-01-01', aadhaar: '123412341234', fatherName: 'F', motherName: 'M', guardianPhone: '9830077777', subjectIds: ['c10-mathematics'], password: 'web123', source: 'WEBSITE' })
      .expect(201);
    const token = await adminToken();
    const list = await api().get('/api/v1/admin/applications').set(bearer(token)).expect(200);
    expect(list.body.data.find((a: { ref: string }) => a.ref === r.body.ref).source).toBe('WEBSITE');
  });
});
