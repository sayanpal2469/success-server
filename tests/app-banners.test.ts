import { describe, expect, it } from 'vitest';

import { addDays, todayIST } from '../src/lib/time.js';
import { adminToken, api, bearer, makeStudent, useDb } from './helpers.js';

useDb();

describe('app home carousel', () => {
  it('shows each offer to the right audience, in order, within its dates', async () => {
    const t = await adminToken();
    const mk = (title: string, over: Record<string, unknown> = {}) =>
      api().post('/api/v1/admin/banners').set(bearer(t)).send({ title, image: 'https://example.com/a.jpg', placement: 'App home carousel', action: 'SCREEN', link: '/fees', ...over }).expect(201);
    await mk('Everyone offer', { audience: 'Everyone' });
    await mk('Guests only', { audience: 'Guests', action: 'URL', link: 'https://successtutorials.in/admission' });
    await mk('Students only', { audience: 'Students' });
    await mk('Class 10 only', { audience: 'class:c10' });
    await mk('Class 12 only', { audience: 'class:c12' });
    await mk('Expired', { audience: 'Everyone', start: addDays(todayIST(), -10), end: addDays(todayIST(), -1) });
    await mk('Switched off', { audience: 'Everyone', active: false });
    await api().post('/api/v1/admin/banners').set(bearer(t)).send({ title: 'Website slide', image: 'https://example.com/b.jpg' }).expect(201);

    const guest = await api().get('/api/v1/public/app-banners').expect(200);
    expect(guest.body.map((b: { title: string }) => b.title)).toEqual(['Everyone offer', 'Guests only']);
    expect(guest.body[1]).toMatchObject({ action: 'URL', link: 'https://successtutorials.in/admission' });

    const { token } = await makeStudent({ classId: 'c10' });
    const mine = await api().get('/api/v1/student/banners').set(bearer(token)).expect(200);
    expect(mine.body.map((b: { title: string }) => b.title)).toEqual(['Everyone offer', 'Students only', 'Class 10 only']);
    await api().post(`/api/v1/public/banners/${mine.body[0].id}/click`).expect(204);
  });
});
