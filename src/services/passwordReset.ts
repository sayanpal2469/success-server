import { createHmac, randomInt } from 'node:crypto';

import { env } from '../config/env.js';
import { hashPassword, revokeAllFor, safeEqual } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { sendMail } from '../lib/mail.js';
import { otpEmail } from '../mail/templates.js';
import { Admin, ResetCode } from '../models/org.js';
import { Student } from '../models/students.js';

/**
 * Forgot password: a 6-digit code is emailed, then the code + a new password sets it. The code is
 * stored as an HMAC (never in plain text), lasts 10 minutes, and dies after 5 wrong tries. Asking
 * again replaces the old code; asking within a minute of the last one does nothing.
 */

export const OTP_MINUTES = 10;
const MAX_TRIES = 5;
const RESEND_SECONDS = 60;

type Kind = 'ADMIN' | 'STUDENT';

const hmac = (kind: Kind, user: string, code: string) => createHmac('sha256', env.JWT_REFRESH_SECRET).update(`reset|${kind}|${user}|${code}`).digest('hex');

async function account(kind: Kind, email: string) {
  if (kind === 'ADMIN') {
    const a = await Admin.findOne({ email, active: true });
    return a ? { id: a._id, name: a.name, email: a.email } : null;
  }
  const s = await Student.findOne({ email, status: 'ACTIVE' });
  return s?.email ? { id: s._id, name: s.name, email: s.email } : null;
}

/** Emails a code if the account exists. The answer is the same either way, so emails can't be probed. */
export async function requestResetCode(kind: Kind, email: string) {
  const who = await account(kind, email);
  if (!who) return;
  const last = await ResetCode.findOne({ kind, user: who.id }).lean();
  if (last && Date.now() - new Date(last.updatedAt!).getTime() < RESEND_SECONDS * 1000) return;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await ResetCode.findOneAndUpdate(
    { kind, user: who.id },
    { $set: { codeHash: hmac(kind, String(who.id), code), expiresAt: new Date(Date.now() + OTP_MINUTES * 60_000), attempts: 0 } },
    { upsert: true },
  );
  await sendMail(await otpEmail({ to: who.email, name: who.name, code, minutes: OTP_MINUTES, panel: kind === 'ADMIN' ? 'admin panel' : 'app' }));
}

const WRONG = 'The code is wrong or has expired — ask for a new one';

/** Checks the code and sets the new password; every signed-in device is signed out. */
export async function resetWithCode(kind: Kind, email: string, code: string, password: string) {
  const who = await account(kind, email);
  if (!who) throw badRequest(WRONG, { field: 'code' });
  const row = await ResetCode.findOne({ kind, user: who.id });
  if (!row || row.expiresAt < new Date() || row.attempts >= MAX_TRIES) throw badRequest(WRONG, { field: 'code' });
  if (!safeEqual(row.codeHash, hmac(kind, String(who.id), code))) {
    row.attempts += 1;
    await row.save();
    throw badRequest(row.attempts >= MAX_TRIES ? 'Too many wrong codes — ask for a new one' : 'The code is wrong — check the email and try again', { field: 'code' });
  }
  await ResetCode.deleteOne({ _id: row._id });
  const hash = await hashPassword(password);
  if (kind === 'ADMIN') await Admin.updateOne({ _id: who.id }, { $set: { passwordHash: hash } });
  else await Student.updateOne({ _id: who.id }, { $set: { passwordHash: hash, passwordChangedAt: new Date() } });
  await revokeAllFor(who.id);
}
