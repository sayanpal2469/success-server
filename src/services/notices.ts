import type { QueryFilter } from 'mongoose';

import { addDays, istInstant, todayIST } from '../lib/time.js';
import { Notice, noticeStatus, type BannerDoc, type NoticeDoc } from '../models/content.js';

/** Filter for notices that are live right now. */
/**
 * App home carousel (offers / ads). `audience`: Everyone (also the old "All"), Students, Guests
 * (visitors not signed in), or `class:<id>` for one class's students.
 */
export const appBannerFilter = (who: { classId: string } | 'GUEST') => {
  const today = todayIST();
  const aud = who === 'GUEST' ? ['Everyone', 'All', 'Guests'] : ['Everyone', 'All', 'Students', `class:${who.classId}`];
  const filter: QueryFilter<BannerDoc> = { placement: 'App home carousel', active: true, audience: { $in: aud }, start: { $lte: today }, $or: [{ end: null }, { end: '' }, { end: { $exists: false } }, { end: { $gte: today } }] };
  return filter;
};
/** Older slides stored a screen name as the action ("Tests", "Notice" …). */
const LEGACY_SCREENS: Record<string, string> = { Tests: '/tests', Test: '/tests', Notice: '/notices', Notices: '/notices', Fees: '/fees', Courses: '/learn', Course: '/learn', Admission: '/register', Routine: '/routine' };

export const appBannerView = (b: { _id: unknown; title: string; subtitle?: string | null; image: string; cta?: string | null; action?: string | null; link?: string | null }) => {
  const legacy = b.action ? LEGACY_SCREENS[b.action] : undefined;
  const link = b.link ?? '';
  const action = legacy ? 'SCREEN' : b.action === 'URL' && !link.startsWith('http') && link.startsWith('/') ? 'SCREEN' : b.action || 'NONE';
  return { id: String(b._id), title: b.title, subtitle: b.subtitle ?? '', image: b.image, cta: b.cta ?? '', action, link: legacy && !link ? legacy : link };
};

export function liveFilter(now = new Date()): QueryFilter<NoticeDoc> {
  const today = todayIST(now);
  return { draft: false, publishAt: { $lte: now }, $or: [{ expires: null }, { expires: { $exists: false } }, { expires: '' }, { expires: { $gte: today } }] };
}

const order = { pinned: -1, publishAt: -1 } as const;

/** Notice board in the app: everyone's notices plus those for the student's class and extra curriculums. */
export function noticesForStudent(s: { classId: string; extras: string[] }, now = new Date()) {
  return Notice.find({
    $and: [liveFilter(now), { showOnApp: { $ne: false } }, { $or: [{ audience: 'All students' }, { audience: 'Class', target: { $in: [s.classId, ...s.extras] } }] }],
  }).sort(order);
}

/** Notice board for guests in the app (no class yet): only notices meant for everyone. */
export function noticesForGuests(now = new Date()) {
  return Notice.find({ $and: [liveFilter(now), { showOnApp: { $ne: false } }, { $or: [{ audience: 'Public website' }, { showOnWebsite: true }] }] }).sort(order);
}

/** Website notice board (same shape the cms-mock served). */
export async function publicNotices(now = new Date()) {
  const rows = await Notice.find({ $and: [liveFilter(now), { $or: [{ audience: 'Public website' }, { showOnWebsite: true }] }] })
    .sort(order)
    .lean();
  return rows.map((n) => ({ id: String(n._id), title: n.title, body: n.body, image: n.image, pinned: n.pinned, publishAt: n.publishAt, expires: n.expires, kind: n.kind }));
}

export const withStatus = <T extends { toJSON(): Record<string, unknown> } & Pick<NoticeDoc, 'draft' | 'publishAt' | 'expires'>>(n: T, now = new Date()) => ({
  ...n.toJSON(),
  status: noticeStatus(n, now, todayIST(now)),
});

/** The day after `from`, India time — topper notices go up then and stay for that one day. */
export function nextDayWindow(from = new Date()) {
  const day = addDays(todayIST(from), 1);
  return { publishAt: istInstant(day), expires: day };
}
