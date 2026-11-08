import { Router } from 'express';
import { z } from 'zod';

import { hashPassword } from '../lib/auth.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { acceptUpload, uploader } from '../lib/files.js';
import { BOARDS, TARGET_EXAMS, zAdmission } from '../lib/schemas.js';
import { todayIST } from '../lib/time.js';
import { parse, zCode, zId, zName, zPassword, zPhone, zText } from '../lib/validate.js';
import { applyLimit, enquiryLimit, reviewLimit, statsLimit, statusLimit, uploadLimit } from '../middleware/limits.js';
import { Banner, Course, Faq, FreeVideo, GalleryPhoto, Post, Ranker, Review, Teacher } from '../models/content.js';
import { readingMinutes } from '../lib/html.js';
import { Enquiry, ENQUIRY_KINDS } from '../models/enquiries.js';
import { ClassDef, Extra } from '../models/catalog.js';
import { getSettings } from '../models/org.js';
import { Application, APPLY_SOURCES, Student } from '../models/students.js';
import { nextApplicationRef } from '../services/admissions.js';
import { loadCatalog, checkEnrolment } from '../services/catalog.js';
import { feeOf } from '../services/fees.js';
import { appBannerFilter, appBannerView, noticesForGuests, publicNotices } from '../services/notices.js';

export const publicRouter = Router();

// Website pages can be cached briefly by the browser. Not "public": a CDN (Hostinger's hcdn) would
// cache one site's CORS header and serve it to the other (it ignores Vary: Origin).
publicRouter.use((req, res, next) => {
  if (req.method === 'GET') res.set('Cache-Control', 'private, max-age=60');
  next();
});

/* ───────────────────────── Website / app content ───────────────────────── */

/** Institute name, contact buttons (only the ones switched on) and whether admission is open. */
publicRouter.get('/site', async (_req, res) => {
  const s = await getSettings();
  const c = s.contact;
  res.json({
    instituteName: s.instituteName,
    centerHead: s.centerHead,
    admissionOpen: s.admissionOpen,
    contact: {
      address: c?.address,
      hours: c?.hours,
      facebook: c?.facebook,
      instagram: c?.instagram,
      phone: c?.showCall ? c.phone : undefined,
      whatsapp: c?.showWhatsApp ? c.whatsapp : undefined,
      whatsappMessage: c?.showWhatsApp ? c.whatsappMessage : undefined,
      email: c?.showMail ? c.email : undefined,
      show: { call: c?.showCall !== false, whatsapp: c?.showWhatsApp !== false, mail: c?.showMail !== false },
    },
  });
});

/** Classes open for admission with subject fees, and extra curriculums — for the admission form. */
publicRouter.get('/catalog', async (_req, res) => {
  const [classes, extras] = await Promise.all([ClassDef.find({ active: true }).sort({ order: 1 }), Extra.find({ active: true }).sort({ order: 1 })]);
  res.json({
    classes: classes.map((c) => ({ id: c._id, name: c.name, group: c.group, batches: c.batches, admissionFee: c.admissionFee, subjects: c.toJSON().subjects })),
    extras: extras.map((e) => ({ id: e._id, name: e.name, description: e.description, monthlyFee: e.monthlyFee })),
    boards: BOARDS,
    targetExams: TARGET_EXAMS,
  });
});

/** App home carousel for visitors who are not signed in (offers, admission ads). */
publicRouter.get('/app-banners', async (_req, res) => {
  const rows = await Banner.find(appBannerFilter('GUEST')).sort({ order: 1, createdAt: 1 }).lean();
  res.json(rows.map(appBannerView));
});

/** Website home hero: active slides within their dates, in admin order. */
publicRouter.get('/banners', async (req, res) => {
  const q = parse(z.object({ placement: z.enum(['Website home hero', 'App home carousel']).default('Website home hero') }), req.query);
  const today = todayIST();
  const rows = await Banner.find({ placement: q.placement, active: true, start: { $lte: today }, $or: [{ end: null }, { end: '' }, { end: { $exists: false } }, { end: { $gte: today } }] }).sort({ order: 1, createdAt: 1 });
  res.json(rows.map((b) => ({ id: String(b._id), title: b.title, subtitle: b.subtitle, image: b.image, cta: b.cta, link: b.link })));
});

publicRouter.post('/banners/:id/:stat', statsLimit, async (req, res) => {
  const id = parse(zId, req.params.id);
  const stat = parse(z.enum(['view', 'click']), req.params.stat);
  const r = await Banner.updateOne({ _id: id }, { $inc: stat === 'view' ? { views: 1 } : { clicks: 1 } });
  if (!r.matchedCount) throw notFound('Banner');
  res.status(204).end();
});

/** Website notice board (live notices marked for the website, pinned first). */
publicRouter.get('/announcements', async (_req, res) => {
  res.json(await publicNotices());
});

/** Notice board for guests in the app. */
publicRouter.get('/notices', async (_req, res) => {
  res.json(await noticesForGuests().limit(50));
});

publicRouter.get('/rankers', async (_req, res) => {
  res.json(await Ranker.find({ visible: true }).sort({ order: 1, createdAt: 1 }));
});

/** Best teachers: public profile fields only (no phone, email or address). */
publicRouter.get('/teachers', async (_req, res) => {
  const rows = await Teacher.find({ visible: true }).sort({ order: 1, createdAt: 1 }).lean();
  res.json(
    rows.map((t) => ({
      id: String(t._id),
      name: t.name,
      photo: t.photo,
      subject: t.subject || [...new Set(t.assignments.map((a) => a.subject))].join(', '),
      qualification: t.qualification,
      experience: t.experience,
      about: t.about,
    })),
  );
});

/** Approved reviews (the website's testimonials). */
publicRouter.get('/reviews', async (_req, res) => {
  const rows = await Review.find({ status: 'APPROVED' }).sort({ order: 1, createdAt: -1 }).limit(100).lean();
  res.json(rows.map((r) => ({ id: String(r._id), name: r.name, role: r.role, text: r.text, rating: r.rating, at: r.createdAt })));
});

/** "Write a review" on the website — shown only after the admin approves it. */
publicRouter.post('/reviews', reviewLimit, async (req, res) => {
  const body = parse(
    z.object({
      name: zName,
      role: zText(120).default(''),
      text: z.string().trim().min(20, 'Please write a little more (at least 20 characters)').max(1500),
      rating: z.number().int().min(1).max(5),
      phone: zPhone.optional(),
      website: z.string().max(200).optional(),
    }),
    req.body,
  );
  if (body.website) return res.status(201).json({ ok: true });
  const { website: _trap, ...data } = body;
  await Review.create({ ...data, status: 'PENDING', source: 'WEBSITE' });
  res.status(201).json({ ok: true });
});

publicRouter.get('/gallery', async (_req, res) => {
  const rows = await GalleryPhoto.find({ visible: true }).sort({ order: 1, createdAt: 1 }).lean();
  res.json(rows.map((g) => ({ id: String(g._id), image: g.image, caption: g.caption, album: g.album })));
});

publicRouter.get('/faqs', async (_req, res) => {
  const rows = await Faq.find({ visible: true }).sort({ order: 1, createdAt: 1 }).lean();
  res.json(rows.map((f) => ({ id: String(f._id), q: f.q, a: f.a })));
});

/** Published blog posts, newest first (with the full text — there are only a few). */
publicRouter.get('/posts', async (_req, res) => {
  const rows = await Post.find({ published: true, date: { $lte: todayIST() } }).sort({ date: -1, createdAt: -1 }).lean();
  res.json(rows.map((p) => ({ id: String(p._id), slug: p.slug, title: p.title, excerpt: p.excerpt, body: p.body, cover: p.cover, tags: p.tags, date: p.date, minutes: readingMinutes(p.body) })));
});

/** Free YouTube classes — anyone can watch the videos of the class they pick. */
publicRouter.get('/free-videos', async (req, res) => {
  const q = parse(z.object({ classId: zCode.optional(), subject: z.string().max(80).optional() }), req.query);
  const filter: Record<string, unknown> = { published: true };
  if (q.classId) filter.classId = q.classId;
  if (q.subject) filter.subject = q.subject;
  const rows = await FreeVideo.find(filter).sort({ order: 1, createdAt: -1 }).limit(500);
  if (!q.classId) {
    const counts: Record<string, number> = {};
    rows.forEach((v) => (counts[v.classId] = (counts[v.classId] ?? 0) + 1));
    return res.json({ counts, videos: rows });
  }
  res.json(rows);
});

/**
 * Published courses for the website (course pages, enquiry form): details and the module / lesson
 * outline. Lesson files and links are never sent — those open only in the app.
 */
publicRouter.get('/courses', async (_req, res) => {
  const [rows, cat] = await Promise.all([Course.find({ published: true }).sort({ createdAt: 1 }).lean(), loadCatalog()]);
  res.json(
    rows.map((c) => {
      const lessons = c.modules.flatMap((m) => m.lessons);
      const classIds = c.access?.classes ?? [];
      const extras = c.access?.extras ?? [];
      return {
        id: String(c._id),
        title: c.title,
        subtitle: c.subtitle,
        description: c.description,
        cover: c.cover,
        teacher: c.teacher,
        classIds,
        classNames: classIds.map((id) => cat.classes.get(id)?.name ?? id),
        extras,
        extraNames: extras.map((id) => cat.extras.get(id)?.name ?? id),
        modules: c.modules.map((m) => ({ title: m.title, lessons: m.lessons.map((l) => ({ title: l.title, kind: l.kind, duration: l.duration, freePreview: l.freePreview })) })),
        lessonCount: lessons.length,
        videoCount: lessons.filter((l) => l.kind === 'VIDEO').length,
        pdfCount: lessons.filter((l) => l.kind === 'PDF').length,
      };
    }),
  );
});

/* ───────────────────────── Enquiries / free demo (website) ───────────────────────── */

const enquiryBody = z.object({
  kind: z.enum(ENQUIRY_KINDS).default('ENQUIRY'),
  name: zName,
  phone: zPhone,
  classId: zCode.optional(),
  subjectIds: z.array(zCode).max(20).default([]),
  extras: z.array(zCode).max(10).default([]),
  courseId: zId.optional(),
  slot: zText(80).optional(),
  message: zText(1000).default(''),
  utm: z.record(z.string().regex(/^utm_[a-z_]{1,20}$/), zText(120)).optional(),
  /** Honeypot — real visitors never see this field. */
  website: z.string().max(200).optional(),
});

publicRouter.post('/enquiries', enquiryLimit, async (req, res) => {
  const body = parse(enquiryBody, req.body);
  // A bot filled the hidden field: answer as usual, store nothing.
  if (body.website) return res.status(201).json({ ok: true });
  const cat = await loadCatalog();
  const cls = body.classId ? cat.classes.get(body.classId) : undefined;
  if (body.classId && !cls) throw badRequest('Unknown class', { field: 'classId' });
  const offered = new Set(cls?.subjects.map((s) => s._id) ?? []);
  if (body.subjectIds.some((id) => !offered.has(id))) throw badRequest('Choose subjects of the selected class', { field: 'subjectIds' });
  if (body.extras.some((id) => !cat.extras.get(id))) throw badRequest('Unknown extra curriculum', { field: 'extras' });
  if (body.courseId && !(await Course.exists({ _id: body.courseId, published: true }))) throw badRequest('Unknown course', { field: 'courseId' });
  const recent = await Enquiry.countDocuments({ phone: body.phone, createdAt: { $gte: new Date(Date.now() - 24 * 3600_000) } });
  if (recent >= 5) throw unprocessable('TOO_MANY_ENQUIRIES', 'We already have your enquiry — the office will call you soon');
  const { courseId, website: _trap, ...data } = body;
  const e = await Enquiry.create({ ...data, subjectIds: [...new Set(data.subjectIds)], extras: [...new Set(data.extras)], course: courseId });
  res.status(201).json({ ok: true, id: String(e._id) });
});

/* ───────────────────────── Admission requests (app and website) ───────────────────────── */

/** Photo (public) or a document scan (private) for the admission form. */
publicRouter.post('/uploads/photo', uploadLimit, uploader('image', 'public'), async (req, res) => {
  res.status(201).json(await acceptUpload(req, 'public'));
});
publicRouter.post('/uploads/document', uploadLimit, uploader('doc', 'private'), async (req, res) => {
  const f = await acceptUpload(req, 'private');
  // The applicant only needs the reference to attach it to the form; nobody can open it without a signed admin link.
  res.status(201).json(f);
});

/** The email becomes the app login, so it is required here and must not belong to a student already. */
const applyBody = zAdmission.extend({ email: z.string().trim().toLowerCase().email('Enter a valid email').max(160), password: zPassword, source: z.enum(APPLY_SOURCES).default('APP') });

publicRouter.post('/admissions', applyLimit, async (req, res) => {
  const settings = await getSettings();
  if (!settings.admissionOpen) throw unprocessable('ADMISSION_CLOSED', 'Admission requests are closed right now — please contact the office');
  const body = parse(applyBody, req.body);
  const cat = await loadCatalog();
  const { subjectIds, extras } = checkEnrolment(cat, body, true);
  if (await Student.exists({ email: body.email }).setOptions({ withDeleted: true })) throw conflict('This email already belongs to a student — log in with it, or use another email', { field: 'email' });
  const pending = await Application.countDocuments({ phone: body.phone, status: 'PENDING' });
  if (pending >= 3) throw unprocessable('TOO_MANY_PENDING', 'There are already requests waiting for this phone number — the office will contact you');
  const { password, ...data } = body;
  const app = await Application.create({ ...data, subjectIds, extras, ref: await nextApplicationRef(), passwordHash: await hashPassword(password) });
  res.status(201).json({ ref: app.ref, status: app.status, submittedAt: app.get('createdAt'), monthlyFee: feeOf({ ...data, subjectIds, extras }, cat) });
});

/** "Request status" in the app: reference + the phone used in the form. */
publicRouter.post('/admissions/status', statusLimit, async (req, res) => {
  const body = parse(z.object({ ref: z.string().trim().toUpperCase().max(30), phone: zPhone }), req.body);
  const app = await Application.findOne({ ref: body.ref, phone: body.phone });
  if (!app) throw notFound('Admission request');
  const student = app.student ? await Student.findById(app.student, { studentId: 1 }).lean() : null;
  const cat = await loadCatalog();
  res.json({
    ref: app.ref,
    name: app.name,
    className: cat.classes.get(app.classId)?.name ?? app.classId,
    status: app.status,
    submittedAt: app.get('createdAt'),
    reviewedAt: app.reviewedAt,
    rejectReason: app.status === 'REJECTED' ? app.rejectReason : undefined,
    // Approved: the Student ID to sign in with (password is the one chosen in the form).
    studentId: app.status === 'APPROVED' ? student?.studentId : undefined,
  });
});
