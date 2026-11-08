import { Router } from 'express';
import type { Model } from 'mongoose';
import { z } from 'zod';

import { adminOf } from '../../lib/auth.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { acceptUpload, signFileUrl, uploader, type FileKind } from '../../lib/files.js';
import { todayIST } from '../../lib/time.js';
import { parse, zCode, zDate, zEmail, zId, zOptPhone, zPatch, zText, zUrl } from '../../lib/validate.js';
import { youtubeId } from '../../lib/youtube.js';
import { ClassDef, Extra } from '../../models/catalog.js';
import { Banner, Course, ensureTeacherCodes, Faq, FreeVideo, GalleryPhoto, nextTeacherCode, Notice, NOTICE_AUDIENCES, Post, Ranker, REVIEW_STATUSES, Review, Teacher } from '../../models/content.js';
import { cleanHtml, readingMinutes, slugify } from '../../lib/html.js';
import { getSettings, Settings } from '../../models/org.js';
import { Student } from '../../models/students.js';
import { withStatus } from '../../services/notices.js';
import { groupFilter, notifyStudents } from '../../services/notify.js';

export const contentRouter = Router();

/** List / create / edit / delete / reorder for simple ordered collections. */
function crud<S extends z.ZodObject>(path: string, model: Model<any>, schema: S, map?: (body: z.infer<S>) => Record<string, unknown>) {
  const toDoc = (b: z.infer<S>) => (map ? map(b) : (b as Record<string, unknown>));
  contentRouter.get(path, async (_req, res) => {
    res.json(await model.find().sort({ order: 1, createdAt: 1 }));
  });
  contentRouter.post(path, async (req, res) => {
    const body = parse(schema, req.body);
    const last = await model.findOne({}, { order: 1 }).sort({ order: -1 }).lean<{ order?: number }>();
    res.status(201).json(await model.create({ order: (last?.order ?? 0) + 1, ...toDoc(body) }));
  });
  contentRouter.patch(`${path}/:id`, async (req, res) => {
    const doc = await model.findById(parse(zId, req.params.id));
    if (!doc) throw notFound();
    const body = parse(zPatch(schema), req.body) as z.infer<S>;
    doc.set(toDoc(body));
    await doc.save();
    res.json(doc);
  });
  contentRouter.delete(`${path}/:id`, async (req, res) => {
    const r = await model.deleteOne({ _id: parse(zId, req.params.id) });
    if (!r.deletedCount) throw notFound();
    res.status(204).end();
  });
  /** Saves the order shown in the panel: ids in display order. */
  contentRouter.put(`${path}/order`, async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(zId).max(1000) }), req.body);
    await model.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: i + 1 } } } })));
    res.status(204).end();
  });
}

/* ───────────────────────── Uploads ───────────────────────── */

const KINDS: FileKind[] = ['image', 'pdf', 'video', 'doc'];
for (const kind of KINDS) {
  const vis = kind === 'doc' ? 'private' : 'public';
  contentRouter.post(`/uploads/${kind}`, uploader(kind, vis), async (req, res) => {
    res.status(201).json(await acceptUpload(req, vis));
  });
}

/* ───────────────────────── Notice board ───────────────────────── */

const noticeBody = z.object({
  title: z.string().trim().min(1).max(200),
  body: zText(5000).default(''),
  image: zUrl.optional(),
  audience: z.enum(NOTICE_AUDIENCES).default('All students'),
  target: zCode.optional(),
  pinned: z.boolean().default(false),
  /** DRAFT keeps it hidden; anything else publishes at `publishAt` (now if omitted). */
  status: z.enum(['DRAFT', 'LIVE', 'SCHEDULED']).optional(),
  publishAt: z.iso.datetime({ offset: true }).optional(),
  expires: z.union([zDate, z.literal('')]).optional(),
  showOnWebsite: z.boolean().default(false),
  showOnApp: z.boolean().default(true),
  kind: z.enum(['GENERAL', 'EXAM']).default('GENERAL'),
});

async function noticeFields(b: Partial<z.infer<typeof noticeBody>>) {
  const { status, publishAt, expires, ...rest } = b;
  const out: Record<string, unknown> = { ...rest };
  if (status !== undefined) out.draft = status === 'DRAFT';
  if (publishAt !== undefined) out.publishAt = new Date(publishAt);
  else if (status === 'LIVE') out.publishAt = new Date();
  if (expires !== undefined) out.expires = expires || undefined;
  if (b.audience === 'Class') {
    if (!b.target) throw badRequest('Pick the class', { field: 'target' });
    if (!(await ClassDef.exists({ _id: b.target })) && !(await Extra.exists({ _id: b.target }))) throw badRequest('Unknown class', { field: 'target' });
  }
  if (b.audience && b.audience !== 'Class') out.target = undefined;
  if (b.audience === 'Public website') out.showOnWebsite = true;
  return out;
}

contentRouter.get('/notices', async (req, res) => {
  const q = parse(z.object({ status: z.enum(['LIVE', 'SCHEDULED', 'EXPIRED', 'DRAFT']).optional(), kind: z.enum(['GENERAL', 'TOPPER', 'ROUTINE', 'EXAM']).optional() }), req.query);
  const rows = await Notice.find(q.kind ? { kind: q.kind } : {}).sort({ pinned: -1, publishAt: -1 }).limit(1000);
  const now = new Date();
  res.json(rows.map((n) => withStatus(n, now)).filter((n) => !q.status || n.status === q.status));
});

/** A notice that is live now and meant for the app goes to the students' bell too. */
async function notifyNotice(n: InstanceType<typeof Notice>) {
  if (withStatus(n).status !== 'LIVE' || n.showOnApp === false || n.audience === 'Public website') return;
  const filter = n.audience === 'Class' && n.target ? groupFilter(n.target) : {};
  const text = n.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  await notifyStudents(filter, { type: n.kind === 'ROUTINE' ? 'routine' : 'notice', title: n.title, body: text.length > 140 ? `${text.slice(0, 137)}…` : text, href: `/notices/${String(n._id)}` });
}

contentRouter.post('/notices', async (req, res) => {
  const body = parse(noticeBody, req.body);
  const n = await Notice.create({ ...(await noticeFields(body)), by: adminOf(req).name });
  if (n.kind !== 'ROUTINE') await notifyNotice(n);
  res.status(201).json(withStatus(n));
});

contentRouter.patch('/notices/:id', async (req, res) => {
  const n = await Notice.findById(parse(zId, req.params.id));
  if (!n) throw notFound('Notice');
  const body = parse(zPatch(noticeBody), req.body);
  if (body.audience === undefined && body.target !== undefined) body.audience = n.audience as (typeof NOTICE_AUDIENCES)[number];
  const wasLive = withStatus(n).status === 'LIVE';
  n.set(await noticeFields(body));
  if (n.audience === 'Class' && !n.target) throw badRequest('Pick the class', { field: 'target' });
  await n.save();
  // A draft that goes live now reaches the bell; edits to a live notice don't send it again.
  if (!wasLive) await notifyNotice(n);
  res.json(withStatus(n));
});

contentRouter.delete('/notices/:id', async (req, res) => {
  const r = await Notice.deleteOne({ _id: parse(zId, req.params.id) });
  if (!r.deletedCount) throw notFound('Notice');
  res.status(204).end();
});

/* ───────────────────────── Website ───────────────────────── */

crud(
  '/banners',
  Banner,
  z.object({
    title: z.string().trim().min(1).max(160),
    subtitle: zText(300).default(''),
    placement: z.enum(['Website home hero', 'App home carousel']).default('Website home hero'),
    image: zUrl.refine((v) => v !== '', 'Add an image'),
    cta: zText(60).default(''),
    action: zText(60).default(''),
    link: zText(500).default(''),
    audience: zText(60).default('Everyone'),
    start: zDate.default(() => todayIST()),
    end: z.union([zDate, z.literal('')]).optional(),
    active: z.boolean().default(true),
  }),
);

crud(
  '/rankers',
  Ranker,
  z.object({
    name: z.string().trim().min(1).max(120),
    photo: zUrl.optional(),
    exam: zText(120).default(''),
    year: zText(10).default(''),
    result: zText(120).default(''),
    className: zText(60).default(''),
    quote: zText(500).default(''),
    visible: z.boolean().default(true),
  }),
);

/** A private upload (`/files/…`), possibly a signed link the panel got back; '' removes it. */
const zDoc = z.union([z.literal(''), z.string().trim().max(400).regex(/^\/files\/[a-f0-9]{32}\.(jpg|jpeg|png|webp|pdf)(\?.*)?$/, 'Upload the file first')]).optional();

const teacherBody = z.object({
  name: z.string().trim().min(1).max(120),
  photo: zUrl.optional(),
  phone: zOptPhone,
  email: zEmail,
  address: zText(300).default(''),
  joined: z.union([z.literal(''), zDate]).default(''),
  assignments: z.array(z.object({ groupId: zCode, subject: z.string().trim().min(1).max(120) })).max(100).default([]),
  subject: zText(120).default(''),
  qualification: zText(200).default(''),
  experience: zText(60).default(''),
  about: zText(2000).default(''),
  visible: z.boolean().default(true),
  /** Optional Aadhaar scans (private uploads), front and back. */
  aadhaarFront: zDoc,
  aadhaarBack: zDoc,
});

/** Every assignment must name an existing class subject or an extra curriculum. */
async function checkAssignments(list?: { groupId: string; subject: string }[]) {
  if (!list?.length) return;
  const ids = [...new Set(list.map((a) => a.groupId))];
  const [classes, extras] = await Promise.all([ClassDef.find({ _id: { $in: ids } }, { subjects: 1 }).lean(), Extra.find({ _id: { $in: ids } }, { name: 1 }).lean()]);
  for (const a of list) {
    const c = classes.find((x) => x._id === a.groupId);
    const e = extras.find((x) => x._id === a.groupId);
    if (!(c?.subjects.some((s) => s.name === a.subject) || e)) throw badRequest(`Unknown class or subject: ${a.subject}`, { field: 'assignments' });
  }
}

/** Duplicate class + subject pairs are dropped. */
const uniqueAssignments = (list: { groupId: string; subject: string }[]) => list.filter((a, i) => list.findIndex((b) => b.groupId === a.groupId && b.subject === a.subject) === i);

/** Aadhaar scans are private files: the panel gets short-lived signed links. */
const teacherView = (t: InstanceType<typeof Teacher>) => {
  const json = t.toJSON() as Record<string, unknown>;
  return { ...json, aadhaarFront: t.aadhaarFront ? signFileUrl(t.aadhaarFront, 240) : undefined, aadhaarBack: t.aadhaarBack ? signFileUrl(t.aadhaarBack, 240) : undefined };
};

/** Stored values: duplicate class + subject pairs dropped; a signed link sent back is stored without its signature. */
const teacherFields = (b: Partial<z.infer<typeof teacherBody>>) => {
  const out: Record<string, unknown> = { ...b };
  if (b.assignments) out.assignments = uniqueAssignments(b.assignments);
  for (const k of ['aadhaarFront', 'aadhaarBack'] as const) if (k in b) out[k] = b[k] ? b[k]!.split('?')[0] : undefined;
  return out;
};

contentRouter.get('/teachers', async (_req, res) => {
  await ensureTeacherCodes();
  res.json((await Teacher.find().sort({ order: 1, createdAt: 1 })).map(teacherView));
});
contentRouter.post('/teachers', async (req, res) => {
  const body = parse(teacherBody, req.body);
  await checkAssignments(body.assignments);
  const last = await Teacher.findOne({}, { order: 1 }).sort({ order: -1 }).lean<{ order?: number }>();
  for (let tries = 0; ; tries++) {
    try {
      res.status(201).json(teacherView(await Teacher.create({ ...teacherFields(body), code: await nextTeacherCode(), order: (last?.order ?? 0) + 1 })));
      return;
    } catch (e) {
      // Two teachers added at the same moment can pick the same ID; take the next one.
      if ((e as { code?: number }).code !== 11000 || tries >= 3) throw e;
    }
  }
});
contentRouter.patch('/teachers/:id', async (req, res) => {
  const t = await Teacher.findById(parse(zId, req.params.id));
  if (!t) throw notFound();
  const body = parse(zPatch(teacherBody), req.body);
  await checkAssignments(body.assignments);
  t.set(teacherFields(body));
  await t.save();
  res.json(teacherView(t));
});
contentRouter.delete('/teachers/:id', async (req, res) => {
  const r = await Teacher.deleteOne({ _id: parse(zId, req.params.id) });
  if (!r.deletedCount) throw notFound();
  res.status(204).end();
});
contentRouter.put('/teachers/order', async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(zId).max(1000) }), req.body);
  await Teacher.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: i + 1 } } } })));
  res.status(204).end();
});

/* ───────────────────────── Website: reviews, gallery, FAQs, blog ───────────────────────── */

/** Reviews: the ones written on the website wait as PENDING until approved here. */
crud(
  '/reviews',
  Review,
  z.object({
    name: z.string().trim().min(1).max(120),
    role: zText(120).default(''),
    text: z.string().trim().min(1).max(1500),
    rating: z.number().int().min(1).max(5).default(5),
    phone: zOptPhone,
    status: z.enum(REVIEW_STATUSES).default('APPROVED'),
  }),
  (b) => ({ ...b, ...(b.phone === '' ? { phone: undefined } : {}) }),
);

crud(
  '/gallery',
  GalleryPhoto,
  z.object({
    image: zUrl.refine((v) => v !== '', 'Add a photo'),
    caption: zText(200).default(''),
    album: zText(60).default('Classroom'),
    visible: z.boolean().default(true),
  }),
);

crud(
  '/faqs',
  Faq,
  z.object({
    q: z.string().trim().min(1).max(300),
    a: z.string().trim().min(1).max(3000),
    visible: z.boolean().default(true),
  }),
);

const postBody = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z.string().trim().max(80).regex(/^[a-z0-9-]*$/, 'Use lowercase letters, numbers and dashes').optional(),
  excerpt: zText(500).default(''),
  body: z.string().max(100_000).default(''),
  cover: zUrl.optional(),
  tags: z.array(zText(40)).max(10).default([]),
  date: zDate.default(() => todayIST()),
  published: z.boolean().default(true),
});
const postView = (p: InstanceType<typeof Post>) => ({ ...p.toJSON(), minutes: readingMinutes(p.body) });

/** A free slug: the asked one (or one from the title), with -2, -3 … if it is taken. */
async function freeSlug(wanted: string, except?: unknown) {
  const base = slugify(wanted);
  for (let n = 1; n < 100; n++) {
    const s = n === 1 ? base : `${base}-${n}`;
    if (!(await Post.exists({ slug: s, ...(except ? { _id: { $ne: except } } : {}) }))) return s;
  }
  throw conflict('Choose a different link for this post');
}

contentRouter.get('/posts', async (_req, res) => {
  res.json((await Post.find().sort({ date: -1, createdAt: -1 })).map(postView));
});
contentRouter.post('/posts', async (req, res) => {
  const b = parse(postBody, req.body);
  const p = await Post.create({ ...b, body: cleanHtml(b.body), slug: await freeSlug(b.slug || b.title) });
  res.status(201).json(postView(p));
});
contentRouter.patch('/posts/:id', async (req, res) => {
  const p = await Post.findById(parse(zId, req.params.id));
  if (!p) throw notFound('Post');
  const b = parse(zPatch(postBody), req.body);
  const { slug, body, ...rest } = b;
  p.set(rest);
  if (body !== undefined) p.body = cleanHtml(body);
  if (slug !== undefined && slug !== p.slug) p.slug = await freeSlug(slug || p.title, p._id);
  await p.save();
  res.json(postView(p));
});
contentRouter.delete('/posts/:id', async (req, res) => {
  const r = await Post.deleteOne({ _id: parse(zId, req.params.id) });
  if (!r.deletedCount) throw notFound('Post');
  res.status(204).end();
});

const zYoutube = z
  .string()
  .trim()
  .max(500)
  .refine((v) => !!youtubeId(v), 'Paste a YouTube link');

crud(
  '/free-videos',
  FreeVideo,
  z.object({
    classId: zCode,
    subject: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(200),
    url: zYoutube,
    duration: zText(20).default(''),
    published: z.boolean().default(true),
  }),
  (b) => (b.url ? { ...b, youtubeId: youtubeId(b.url) } : b),
);

const contactBody = z
  .object({
    phone: zText(30),
    whatsapp: zText(30),
    whatsappMessage: zText(500),
    email: zText(160),
    address: zText(500),
    hours: zText(120),
    facebook: zText(300),
    instagram: zText(300),
    showCall: z.boolean(),
    showWhatsApp: z.boolean(),
    showMail: z.boolean(),
  })
  .partial();

contentRouter.get('/website/contact', async (_req, res) => {
  res.json((await getSettings()).contact);
});

contentRouter.put('/website/contact', async (req, res) => {
  const body = parse(contactBody, req.body);
  await getSettings();
  const set = Object.fromEntries(Object.entries(body).map(([k, v]) => [`contact.${k}`, v]));
  const s = await Settings.findByIdAndUpdate('main', { $set: set }, { returnDocument: 'after' });
  res.json(s!.contact);
});

/* ───────────────────────── Courses ───────────────────────── */

const lessonBody = z
  .object({
    id: zId.optional(),
    title: z.string().trim().min(1).max(200),
    kind: z.enum(['VIDEO', 'PDF']),
    source: z.enum(['YOUTUBE', 'UPLOAD']),
    url: z.string().trim().min(1).max(1000),
    fileName: zText(200).optional(),
    size: z.number().int().min(0).optional(),
    duration: zText(20).optional(),
    freePreview: z.boolean().default(false),
  })
  .superRefine((l, ctx) => {
    if (l.source === 'YOUTUBE' && (l.kind !== 'VIDEO' || !youtubeId(l.url))) ctx.addIssue({ code: 'custom', message: 'Paste a YouTube link', path: ['url'] });
    if (l.source === 'UPLOAD' && !l.url.startsWith('/uploads/')) ctx.addIssue({ code: 'custom', message: 'Upload the file first', path: ['url'] });
  });

const courseBody = z.object({
  title: z.string().trim().min(1).max(200),
  subtitle: zText(300).default(''),
  description: zText(10_000).default(''),
  cover: zUrl.optional(),
  teacher: zText(120).default(''),
  access: z.object({ classes: z.array(zCode).max(30).default([]), extras: z.array(zCode).max(30).default([]) }).default({ classes: [], extras: [] }),
  published: z.boolean().default(false),
  modules: z.array(z.object({ id: zId.optional(), title: z.string().trim().min(1).max(200), lessons: z.array(lessonBody).max(500).default([]) })).max(100).default([]),
});

async function courseFields(b: Partial<z.infer<typeof courseBody>>) {
  if (b.access) {
    const [c, e] = await Promise.all([ClassDef.countDocuments({ _id: { $in: b.access.classes } }), Extra.countDocuments({ _id: { $in: b.access.extras } })]);
    if (c !== new Set(b.access.classes).size || e !== new Set(b.access.extras).size) throw badRequest('Unknown class or extra curriculum in access', { field: 'access' });
  }
  const { modules, ...rest } = b;
  if (!modules) return rest;
  // Keep lesson ids stable across edits so "done" progress survives reordering.
  return {
    ...rest,
    modules: modules.map(({ id, lessons, ...m }) => ({
      ...(id ? { _id: id } : {}),
      ...m,
      lessons: lessons.map(({ id: lid, ...l }) => ({ ...(lid ? { _id: lid } : {}), ...l, youtubeId: l.source === 'YOUTUBE' ? youtubeId(l.url) : undefined })),
    })),
  };
}

contentRouter.get('/courses', async (_req, res) => {
  const rows = await Course.find().sort({ createdAt: -1 });
  res.json(rows.map((c) => ({ ...c.toJSON(), lessons: c.modules.reduce((a, m) => a + m.lessons.length, 0) })));
});

contentRouter.post('/courses', async (req, res) => {
  const body = parse(courseBody, req.body);
  res.status(201).json(await Course.create(await courseFields(body)));
});

contentRouter.get('/courses/:id', async (req, res) => {
  const c = await Course.findById(parse(zId, req.params.id));
  if (!c) throw notFound('Course');
  res.json(c);
});

contentRouter.patch('/courses/:id', async (req, res) => {
  const c = await Course.findById(parse(zId, req.params.id));
  if (!c) throw notFound('Course');
  c.set(await courseFields(parse(zPatch(courseBody), req.body)));
  await c.save();
  res.json(c);
});

contentRouter.delete('/courses/:id', async (req, res) => {
  const id = parse(zId, req.params.id);
  const r = await Course.deleteOne({ _id: id });
  if (!r.deletedCount) throw notFound('Course');
  await Student.updateMany({ courseIds: id }, { $pull: { courseIds: id } });
  res.status(204).end();
});

/** Students who can open the course (by class, extra curriculum or one by one). */
contentRouter.get('/courses/:id/students', async (req, res) => {
  const c = await Course.findById(parse(zId, req.params.id), { access: 1 }).lean();
  if (!c) throw notFound('Course');
  const rows = await Student.find(
    { status: 'ACTIVE', $or: [{ classId: { $in: c.access?.classes ?? [] } }, { extras: { $in: c.access?.extras ?? [] } }, { courseIds: c._id }] },
    { name: 1, studentId: 1, classId: 1, batch: 1, courseIds: 1, extras: 1 },
  ).sort({ name: 1 });
  res.json(rows.map((s) => ({ ...s.toJSON(), via: (c.access?.classes ?? []).includes(s.classId) ? 'CLASS' : (c.access?.extras ?? []).some((e) => s.extras.includes(e)) ? 'EXTRA' : 'SINGLE' })));
});

/** Enrol / remove single students. */
contentRouter.post('/courses/:id/students', async (req, res) => {
  const id = parse(zId, req.params.id);
  if (!(await Course.exists({ _id: id }))) throw notFound('Course');
  const body = parse(z.object({ add: z.array(zId).max(500).default([]), remove: z.array(zId).max(500).default([]) }), req.body);
  if (body.add.length) await Student.updateMany({ _id: { $in: body.add } }, { $addToSet: { courseIds: id } });
  if (body.remove.length) await Student.updateMany({ _id: { $in: body.remove } }, { $pull: { courseIds: id } });
  res.status(204).end();
});
