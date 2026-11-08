import { describe, expect, it } from 'vitest';

import { addDays, nowTimeIST, todayIST } from '../src/lib/time.js';
import { Exam } from '../src/models/tests.js';
import { adminToken, api, bearer, makeStudent, useDb } from './helpers.js';

useDb();

const questions = [
  { q: '2 + 2', options: ['3', '4', '5', '6'], answer: 1 },
  { q: '3 × 3', options: ['6', '9', '12', '3'], answer: 1 },
  { q: '10 − 4', options: ['6', '5', '4', '7'], answer: 0 },
];

/** A written paper: long-answer questions with marks. */
const paper = [
  { section: 'Group A', text: '<p>Solve 3x − 7 = 2x + 5.</p>', marks: 5 },
  { section: 'Group B', text: '<p>Prove that the angles of a triangle add up to 180°.<script>x()</script></p>', marks: 10 },
  { section: 'Group B', text: '<p>Find the area of a circle of radius 7 cm.</p>', marks: 5 },
];

/** A written exam that started a few minutes ago (India time). */
async function liveExam(admin: string, over: Record<string, unknown> = {}) {
  const start = new Date(Date.now() - 5 * 60_000);
  const r = await api()
    .post('/api/v1/admin/exams')
    .set(bearer(admin))
    .send({ title: '1st Unit Test', classId: 'c10', subject: 'Mathematics', date: todayIST(start), start: nowTimeIST(start), duration: 60, questions: paper, ...over })
    .expect(201);
  return r.body.id as string;
}

/** Moves an exam into the past so it can be published. */
const endExam = (id: string) => Exam.updateOne({ _id: id }, { startsAt: new Date(Date.now() - 2 * 3600_000), endsAt: new Date(Date.now() - 3600_000), date: addDays(todayIST(), -1) });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe('written exams', () => {
  it('paper → upload / hand in → admin marks → publish → exam result and annual report card', async () => {
    const admin = await adminToken();
    // A future exam: no paper for students yet.
    const later = await api()
      .post('/api/v1/admin/exams')
      .set(bearer(admin))
      .send({ title: 'Half-yearly', classId: 'c10', subject: 'Mathematics', date: addDays(todayIST(), 3), start: '10:00', duration: 180, questions: paper })
      .expect(201);
    expect(later.body.fullMarks).toBe(20);
    expect(later.body.questions[1].text).not.toContain('script');

    const id = await liveExam(admin);
    const a = await makeStudent({ name: 'Ananya' });
    const b = await makeStudent({ name: 'Rohan' });
    const c = await makeStudent({ name: 'Mitra' });
    const notMine = await makeStudent({ subjectIds: ['c10-bengali'] });

    const list = await api().get('/api/v1/student/tests').set(bearer(a.token)).expect(200);
    const live = list.body.exams.find((e: { id: string }) => e.id === id);
    expect(live).toMatchObject({ status: 'LIVE', total: 20, paperOpen: true, submission: null });
    expect(list.body.exams.find((e: { id: string }) => e.id === later.body.id)).toMatchObject({ status: 'UPCOMING', paperOpen: false });
    expect((await api().get('/api/v1/student/tests').set(bearer(notMine.token)).expect(200)).body.exams).toHaveLength(0);
    await api().get(`/api/v1/student/exams/${id}`).set(bearer(notMine.token)).expect(404);

    const future = await api().get(`/api/v1/student/exams/${later.body.id}`).set(bearer(a.token)).expect(200);
    expect(future.body.questions).toHaveLength(0);
    await api().post(`/api/v1/student/exams/${later.body.id}/submission`).set(bearer(a.token)).send({ mode: 'MANUAL' }).expect(422);

    const detail = await api().get(`/api/v1/student/exams/${id}`).set(bearer(a.token)).expect(200);
    expect(detail.body).toMatchObject({ paperOpen: true, canUpload: true, canHandIn: true });
    expect(detail.body.questions.map((q: { marks: number }) => q.marks)).toEqual([5, 10, 5]);

    // Ananya uploads photos of her notebook as a PDF; Rohan hands his notebook in; Mitra does nothing.
    const up = await api().post('/api/v1/student/uploads/answer').set(bearer(a.token)).attach('file', PDF, { filename: 'answers.pdf', contentType: 'application/pdf' }).expect(201);
    expect(up.body.url).toMatch(/^\/files\/[a-f0-9]{32}\.pdf$/);
    await api().post(`/api/v1/student/exams/${id}/submission`).set(bearer(a.token)).send({ mode: 'UPLOAD', file: '/files/nothere.pdf' }).expect(400);
    const sa = await api().post(`/api/v1/student/exams/${id}/submission`).set(bearer(a.token)).send({ mode: 'UPLOAD', file: up.body.url, pages: 4 }).expect(201);
    expect(sa.body).toMatchObject({ mode: 'UPLOAD', status: 'SUBMITTED', pages: 4 });
    await api().post(`/api/v1/student/exams/${id}/submission`).set(bearer(b.token)).send({ mode: 'MANUAL' }).expect(201);

    // The paper is locked once the exam started; marks need real question ids and fit the marks.
    await api().patch(`/api/v1/admin/exams/${id}`).set(bearer(admin)).send({ questions: paper }).expect(422);
    const sheets = await api().get(`/api/v1/admin/exams/${id}/sheets`).set(bearer(admin)).expect(200);
    const row = (n: string) => sheets.body.rows.find((r: { name: string }) => r.name === n);
    expect(row('Ananya').sheet).toMatchObject({ mode: 'UPLOAD', status: 'SUBMITTED' });
    expect(row('Ananya').sheet.file).toMatch(/^\/files\/.+\?exp=\d+&sig=/);
    expect(row('Rohan').sheet).toMatchObject({ mode: 'MANUAL', by: 'STUDENT' });
    expect(row('Mitra').sheet).toBeNull();
    expect(sheets.body.rows.some((r: { name: string }) => r.name === notMine.student.name)).toBe(false);

    const qids = sheets.body.exam.questions.map((q: { id: string }) => q.id);
    await api().put(`/api/v1/admin/exams/${id}/marks/${a.student._id}`).set(bearer(admin)).send({ marks: { [qids[0]]: 6 } }).expect(400);
    await api().put(`/api/v1/admin/exams/${id}/marks/${a.student._id}`).set(bearer(admin)).send({ total: 25 }).expect(400);
    const ma = await api()
      .put(`/api/v1/admin/exams/${id}/marks/${a.student._id}`)
      .set(bearer(admin))
      .send({ marks: { [qids[0]]: 4, [qids[1]]: 8.5, [qids[2]]: 3 }, remarks: 'Neat work' })
      .expect(200);
    expect(ma.body).toMatchObject({ status: 'CHECKED', total: 15.5 });
    await api().put(`/api/v1/admin/exams/${id}/marks/${b.student._id}`).set(bearer(admin)).send({ total: 18 }).expect(200);
    // The office records Mitra as absent; a checked student can't change their sheet any more.
    await api().put(`/api/v1/admin/exams/${id}/marks/${c.student._id}`).set(bearer(admin)).send({ absent: true }).expect(200);
    await api().put(`/api/v1/admin/exams/${id}/marks/${a.student._id}`).set(bearer(admin)).send({ absent: true }).expect(409);
    await api().post(`/api/v1/student/exams/${id}/submission`).set(bearer(a.token)).send({ mode: 'MANUAL' }).expect(409);

    await api().post(`/api/v1/admin/exams/${id}/publish`).set(bearer(admin)).expect(422);
    await api().get(`/api/v1/student/exams/${id}/result`).set(bearer(a.token)).expect(422);
    await endExam(id);

    const results = await api().get(`/api/v1/admin/exams/${id}/results`).set(bearer(admin)).expect(200);
    expect(results.body.ranking.map((r: { name: string; score: number; rank: number }) => [r.name, r.score, r.rank])).toEqual([
      ['Rohan', 18, 1],
      ['Ananya', 15.5, 2],
    ]);
    expect(results.body.absent.map((s: { name: string }) => s.name)).toContain('Mitra');

    const pub = await api().post(`/api/v1/admin/exams/${id}/publish`).set(bearer(admin)).expect(200);
    expect(pub.body.topperNotice.title).toContain('Topper');
    await api().put(`/api/v1/admin/exams/${id}/marks/${a.student._id}`).set(bearer(admin)).send({ remarks: 'Neat work.' }).expect(200);

    const res = await api().get(`/api/v1/student/exams/${id}/result`).set(bearer(a.token)).expect(200);
    expect(res.body).toMatchObject({ score: 15.5, percent: 77.5, grade: 'B+', rank: 2, of: 2, topper: 18, remarks: 'Neat work.', mode: 'UPLOAD' });
    expect(res.body.questions.map((q: { got: number }) => q.got)).toEqual([4, 8.5, 3]);

    const perf = await api().get('/api/v1/student/performance').set(bearer(a.token)).expect(200);
    expect(perf.body.exams[0]).toMatchObject({ attended: true, score: 15.5, rank: 2 });

    // Annual report card: built from the published written exam (mock tests are not in it).
    const card = await api().get('/api/v1/student/report-card').set(bearer(a.token)).expect(200);
    expect(card.body.card.subjects).toEqual([{ subject: 'Mathematics', exams: 1, score: 15.5, total: 20, average: 77.5, grade: 'B+' }]);
    expect(card.body.card.exams[0]).toMatchObject({ title: '1st Unit Test', score: 15.5, total: 20 });
    expect(card.body.card.classRank).toBe(2);
    const adminCards = await api().get(`/api/v1/admin/report-cards?classId=c10`).set(bearer(admin)).expect(200);
    expect(adminCards.body.cards.find((x: { student: { name: string } }) => x.student.name === 'Rohan').overall).toBe(90);

    // An exam with sheets can't be deleted.
    await api().delete(`/api/v1/admin/exams/${id}`).set(bearer(admin)).expect(409);
    await api().delete(`/api/v1/admin/exams/${later.body.id}`).set(bearer(admin)).expect(204);
  });

  it('refuses a subject the class does not have, and durations outside 10 min – 6 h', async () => {
    const admin = await adminToken();
    await api().post('/api/v1/admin/exams').set(bearer(admin)).send({ title: 'x', classId: 'c10', subject: 'Physics', date: todayIST(), start: '10:00', duration: 60, questions: paper }).expect(400);
    await api().post('/api/v1/admin/exams').set(bearer(admin)).send({ title: 'x', classId: 'c10', subject: 'Mathematics', date: todayIST(), start: '10:00', duration: 5, questions: paper }).expect(400);
    await api().post('/api/v1/admin/exams').set(bearer(admin)).send({ title: 'x', classId: 'c10', subject: 'Mathematics', date: todayIST(), start: '10:00', duration: 400, questions: paper }).expect(400);
    await api().post('/api/v1/admin/exams').set(bearer(admin)).send({ title: 'x', classId: 'c10', subject: 'Mathematics', date: todayIST(), start: '10:00', duration: 60, questions: [] }).expect(400);
  });
});

describe('mock tests', () => {
  it('instant score with answers, limited attempts, questions locked after the first attempt', async () => {
    const admin = await adminToken();
    const m = await api()
      .post('/api/v1/admin/mocks')
      .set(bearer(admin))
      .send({ title: 'Practice', classId: 'c10', subject: 'All subjects', duration: 15, marksPerQ: 1, questions, openFrom: addDays(todayIST(), -1), attemptsAllowed: 2, showAnswers: true, published: true })
      .expect(201);
    const { token } = await makeStudent();

    for (let i = 0; i < 2; i++) {
      const s = await api().post(`/api/v1/student/mocks/${m.body.id}/start`).set(bearer(token)).expect(201);
      expect(s.body.attempt.attemptNo).toBe(i + 1);
      const r = await api()
        .post(`/api/v1/student/attempts/${s.body.attempt.id}/submit`)
        .set(bearer(token))
        .send({ answers: { [s.body.questions[0].id]: 1 } })
        .expect(200);
      expect(r.body).toMatchObject({ kind: 'MOCK', score: 1, correct: 1, skipped: 2 });
      expect(r.body.questions[0].answer).toBe(1);
    }
    await api().post(`/api/v1/student/mocks/${m.body.id}/start`).set(bearer(token)).expect(409);
    const list = await api().get('/api/v1/student/tests').set(bearer(token)).expect(200);
    expect(list.body.mocks[0]).toMatchObject({ status: 'DONE', attemptsUsed: 2, best: 1 });

    await api().patch(`/api/v1/admin/mocks/${m.body.id}`).set(bearer(admin)).send({ questions }).expect(422);
    await api().patch(`/api/v1/admin/mocks/${m.body.id}`).set(bearer(admin)).send({ attemptsAllowed: 0 }).expect(200);
    const board = await api().get(`/api/v1/admin/mocks/${m.body.id}/board`).set(bearer(admin)).expect(200);
    expect(board.body.ranking[0]).toMatchObject({ attempts: 2, best: 1 });
  });

  it('a draft or future mock cannot be started', async () => {
    const admin = await adminToken();
    const draft = await api().post('/api/v1/admin/mocks').set(bearer(admin)).send({ title: 'Draft', classId: 'c10', subject: 'Mathematics', duration: 15, marksPerQ: 1, questions, openFrom: todayIST() }).expect(201);
    const later = await api()
      .post('/api/v1/admin/mocks')
      .set(bearer(admin))
      .send({ title: 'Later', classId: 'c10', subject: 'Mathematics', duration: 15, marksPerQ: 1, questions, openFrom: addDays(todayIST(), 3), published: true })
      .expect(201);
    const { token } = await makeStudent();
    await api().post(`/api/v1/student/mocks/${draft.body.id}/start`).set(bearer(token)).expect(404);
    await api().post(`/api/v1/student/mocks/${later.body.id}/start`).set(bearer(token)).expect(422);
  });
});
