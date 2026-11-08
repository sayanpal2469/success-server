import { Router, type Request } from 'express';
import { z } from 'zod';

import { checkPassword, DUMMY_HASH, endSession, rotateSession, startSession } from '../lib/auth.js';
import { badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { parse, zPassword } from '../lib/validate.js';
import { adminLoginLimit, forgotLimit, loginIpLimit, refreshLimit, resetLimit, studentLoginLimit } from '../middleware/limits.js';
import { Admin } from '../models/org.js';
import { Student } from '../models/students.js';
import { OTP_MINUTES, requestResetCode, resetWithCode } from '../services/passwordReset.js';
import { studentProfile } from './student/serialize.js';

export const authRouter = Router();

const meta = (req: Request) => ({ userAgent: req.get('user-agent'), ip: req.ip });

/** Admin panel: email + password. */
authRouter.post('/admin/login', loginIpLimit, adminLoginLimit, async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().max(160), password: z.string().max(200) }), req.body);
  const a = await Admin.findOne({ email: body.email }).select('+passwordHash');
  const ok = await checkPassword(body.password, a?.passwordHash ?? DUMMY_HASH);
  if (!a || !ok) throw unauthorized('Wrong email or password');
  if (!a.active) throw forbidden('This admin account is disabled');
  a.lastLoginAt = new Date();
  await a.save();
  const tokens = await startSession(a._id, 'ADMIN', meta(req));
  res.json({ ...tokens, admin: { id: String(a._id), name: a.name, email: a.email } });
});

/** Student app: email + password. The Student ID still works in the same box (students admitted before emails). */
authRouter.post('/student/login', loginIpLimit, studentLoginLimit, async (req, res) => {
  const body = parse(z.object({ login: z.string().trim().min(1).max(160).optional(), studentId: z.string().trim().min(1).max(40).optional(), password: z.string().max(200) }), req.body);
  const login = (body.login ?? body.studentId ?? '').trim();
  if (!login) throw badRequest('Enter your email', { field: 'login' });
  const s = await Student.findOne(login.includes('@') ? { email: login.toLowerCase() } : { studentId: login.toUpperCase() }).select('+passwordHash');
  const ok = await checkPassword(body.password, s?.passwordHash ?? DUMMY_HASH);
  if (!s || !ok) throw unauthorized('Wrong email or password');
  if (s.status !== 'ACTIVE') throw forbidden('Your admission is not active — please contact the office');
  const tokens = await startSession(s._id, 'STUDENT', meta(req));
  res.json({ ...tokens, student: await studentProfile(s) });
});

/* Forgot password (admin panel and app): a 6-digit code by email, then code + new password. */

const zLoginEmail = z.string().trim().toLowerCase().email('Enter a valid email').max(160);

for (const [path, kind] of [['admin', 'ADMIN'], ['student', 'STUDENT']] as const) {
  authRouter.post(`/${path}/forgot`, forgotLimit, async (req, res) => {
    const { email } = parse(z.object({ email: zLoginEmail }), req.body);
    await requestResetCode(kind, email);
    res.json({ sent: true, minutes: OTP_MINUTES });
  });
  authRouter.post(`/${path}/reset`, resetLimit, async (req, res) => {
    const body = parse(z.object({ email: zLoginEmail, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'), password: kind === 'ADMIN' ? z.string().min(8, 'At least 8 characters').max(72) : zPassword }), req.body);
    await resetWithCode(kind, body.email, body.code, body.password);
    res.status(204).end();
  });
}

const tokenBody = z.object({ refreshToken: z.string().min(20).max(200) });

/** New access + refresh token; the refresh token rotates on every call. */
authRouter.post('/refresh', refreshLimit, async (req, res) => {
  const { refreshToken } = parse(tokenBody, req.body);
  const { kind: _kind, ...tokens } = await rotateSession(refreshToken, meta(req));
  res.json(tokens);
});

authRouter.post('/logout', refreshLimit, async (req, res) => {
  const { refreshToken } = parse(tokenBody, req.body);
  await endSession(refreshToken);
  res.status(204).end();
});
