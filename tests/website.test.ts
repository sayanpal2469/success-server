import { describe, expect, it } from 'vitest';

import { seedWebsiteContent } from '../src/seed/content.js';
import { adminToken, api, bearer, useDb } from './helpers.js';

useDb();

describe('website content from the admin panel', () => {
  it('reviews written on the website show only after approval', async () => {
    await api().post('/api/v1/public/reviews').send({ name: 'Riya Das', role: 'Parent', text: 'Very good teachers and regular tests every week.', rating: 5, phone: '9830011111' }).expect(201);
    await api().post('/api/v1/public/reviews').send({ name: 'Short', text: 'Good', rating: 5 }).expect(400);
    await api().post('/api/v1/public/reviews').send({ name: 'X', text: 'Too low rating value here really', rating: 0 }).expect(400);
    await api().post('/api/v1/public/reviews').send({ name: 'Bot', text: 'Buy cheap stuff at my website now!!', rating: 5, website: 'spam' }).expect(201);
    expect((await api().get('/api/v1/public/reviews').expect(200)).body).toHaveLength(0);

    const token = await adminToken();
    const list = await api().get('/api/v1/admin/reviews').set(bearer(token)).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: 'Riya Das', status: 'PENDING', source: 'WEBSITE', phone: '+919830011111' });

    await api().patch(`/api/v1/admin/reviews/${list.body[0].id}`).set(bearer(token)).send({ status: 'APPROVED' }).expect(200);
    const pub = (await api().get('/api/v1/public/reviews').expect(200)).body;
    expect(pub).toHaveLength(1);
    expect(pub[0].phone).toBeUndefined();

    // Added by the admin: approved straight away.
    await api().post('/api/v1/admin/reviews').set(bearer(token)).send({ name: 'Mr. Saha', text: 'Disciplined institute.', rating: 4 }).expect(201);
    expect((await api().get('/api/v1/public/reviews').expect(200)).body).toHaveLength(2);
  });

  it('gallery, FAQs and blog', async () => {
    const token = await adminToken();
    const g = await api().post('/api/v1/admin/gallery').set(bearer(token)).send({ image: 'https://example.com/a.jpg', caption: 'Class', album: 'Classroom' }).expect(201);
    await api().post('/api/v1/admin/gallery').set(bearer(token)).send({ image: 'https://example.com/b.jpg', visible: false }).expect(201);
    expect((await api().get('/api/v1/public/gallery').expect(200)).body.map((x: { id: string }) => x.id)).toEqual([g.body.id]);

    await api().post('/api/v1/admin/faqs').set(bearer(token)).send({ q: 'Fees?', a: 'Monthly.' }).expect(201);
    expect((await api().get('/api/v1/public/faqs').expect(200)).body[0]).toMatchObject({ q: 'Fees?', a: 'Monthly.' });

    const p = await api()
      .post('/api/v1/admin/posts')
      .set(bearer(token))
      .send({ title: 'Study Plan 2027!', body: '<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>', date: '2026-01-01' })
      .expect(201);
    expect(p.body.slug).toBe('study-plan-2027');
    expect(p.body.body).not.toMatch(/script|onclick|javascript/);
    const p2 = await api().post('/api/v1/admin/posts').set(bearer(token)).send({ title: 'Study plan 2027', date: '2026-01-02' }).expect(201);
    expect(p2.body.slug).toBe('study-plan-2027-2');
    await api().post('/api/v1/admin/posts').set(bearer(token)).send({ title: 'Draft', published: false }).expect(201);
    await api().post('/api/v1/admin/posts').set(bearer(token)).send({ title: 'Future', date: '2999-01-01' }).expect(201);
    const posts = (await api().get('/api/v1/public/posts').expect(200)).body;
    expect(posts.map((x: { slug: string }) => x.slug)).toEqual(['study-plan-2027-2', 'study-plan-2027']);
  });

  it('sample content fills only empty collections', async () => {
    await seedWebsiteContent();
    const faqs = (await api().get('/api/v1/public/faqs').expect(200)).body;
    // FAQs already had one → untouched; posts already existed → untouched.
    expect(faqs).toHaveLength(1);
    expect((await api().get('/api/v1/public/reviews').expect(200)).body).toHaveLength(2);
  });
});
