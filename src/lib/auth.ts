import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';

import { env } from '../config/env.js';
import { Admin, Session } from '../models/org.js';
import { Student, type StudentHydrated } from '../models/students.js';
import { forbidden, unauthorized } from './errors.js';

export type Kind = 'ADMIN' | 'STUDENT';

/* ───────────────────────── Passwords ───────────────────────── */

const ROUNDS = 11;
export const hashPassword = (pw: string) => bcrypt.hash(pw, ROUNDS);
export const checkPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
/** Compared against when the account doesn't exist, so a wrong ID takes as long as a wrong password. */
export const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', ROUNDS);

/** Easy-to-read temporary password for office admissions and resets (no 0/O, 1/l/I). */
export function tempPassword(len = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/* ───────────────────────── Tokens ───────────────────────── */

type AccessClaims = { sub: string; kind: Kind };

export function signAccess(userId: string, kind: Kind) {
  return jwt.sign({ kind } satisfies Omit<AccessClaims, 'sub'>, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: env.ACCESS_TOKEN_TTL_MIN * 60,
    issuer: 'success-tutorials',
    audience: kind,
    algorithm: 'HS256',
  });
}

function verifyAccess(token: string, kind: Kind): AccessClaims {
  try {
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'success-tutorials', audience: kind, algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (typeof p.sub !== 'string' || p.kind !== kind) throw new Error('bad claims');
    return { sub: p.sub, kind };
  } catch {
    throw unauthorized('Your session has expired — please sign in again');
  }
}

const hashToken = (t: string) => createHmac('sha256', env.JWT_REFRESH_SECRET).update(t).digest('base64url');
const ttlDays = (kind: Kind) => (kind === 'ADMIN' ? env.ADMIN_REFRESH_TTL_DAYS : env.STUDENT_REFRESH_TTL_DAYS);

type Meta = { userAgent?: string; ip?: string };

async function issueRefresh(user: Types.ObjectId | string, kind: Kind, family: string, meta: Meta) {
  const token = randomBytes(48).toString('base64url');
  await Session.create({
    kind,
    user,
    tokenHash: hashToken(token),
    family,
    expiresAt: new Date(Date.now() + ttlDays(kind) * 86_400_000),
    userAgent: meta.userAgent?.slice(0, 300),
    ip: meta.ip,
  });
  return token;
}

/** Access + refresh token pair for a fresh login. */
export async function startSession(user: Types.ObjectId | string, kind: Kind, meta: Meta) {
  const refreshToken = await issueRefresh(user, kind, randomUUID(), meta);
  return { accessToken: signAccess(String(user), kind), refreshToken, expiresIn: env.ACCESS_TOKEN_TTL_MIN * 60 };
}

/**
 * Exchanges a refresh token for a new pair. The old token is revoked; if a revoked token comes back
 * (someone kept a copy), every session of that login is revoked.
 */
export async function rotateSession(token: string, meta: Meta) {
  const s = await Session.findOne({ tokenHash: hashToken(token) });
  if (!s || s.expiresAt < new Date()) throw unauthorized();
  if (s.revokedAt) {
    await Session.updateMany({ family: s.family, revokedAt: null }, { revokedAt: new Date() });
    throw unauthorized('This sign-in was used on another device — please sign in again');
  }
  const kind = s.kind as Kind;
  const owner = kind === 'ADMIN' ? await Admin.findById(s.user) : await Student.findById(s.user);
  const active = owner && (kind === 'ADMIN' ? (owner as { active?: boolean }).active !== false : (owner as StudentHydrated).status === 'ACTIVE');
  if (!active) {
    await Session.updateMany({ family: s.family }, { revokedAt: new Date() });
    throw unauthorized('This account is no longer active');
  }
  // Claim the row atomically so two parallel refreshes can't both succeed.
  const claimed = await Session.findOneAndUpdate({ _id: s._id, revokedAt: null }, { revokedAt: new Date() });
  if (!claimed) throw unauthorized();
  const refreshToken = await issueRefresh(s.user, kind, s.family, meta);
  await Session.updateOne({ _id: s._id }, { replacedBy: hashToken(refreshToken) });
  return { kind, accessToken: signAccess(String(s.user), kind), refreshToken, expiresIn: env.ACCESS_TOKEN_TTL_MIN * 60 };
}

export async function endSession(token: string) {
  const s = await Session.findOne({ tokenHash: hashToken(token) });
  if (s) await Session.updateMany({ family: s.family, revokedAt: null }, { revokedAt: new Date() });
}

export const revokeAllFor = (user: Types.ObjectId | string) => Session.updateMany({ user, revokedAt: null }, { revokedAt: new Date() });

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ───────────────────────── Middleware ───────────────────────── */

function bearer(req: Request) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw unauthorized('Sign in required');
  return h.slice(7).trim();
}

export type AdminUser = { id: string; name: string; email: string };

declare module 'express-serve-static-core' {
  interface Request {
    admin?: AdminUser;
    student?: StudentHydrated;
  }
}

export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const { sub } = verifyAccess(bearer(req), 'ADMIN');
  const a = await Admin.findById(sub);
  if (!a || !a.active) throw forbidden('This admin account is disabled');
  req.admin = { id: String(a._id), name: a.name, email: a.email };
  next();
}

export async function requireStudent(req: Request, _res: Response, next: NextFunction) {
  const { sub } = verifyAccess(bearer(req), 'STUDENT');
  const s = await Student.findById(sub);
  if (!s) throw unauthorized();
  if (s.status !== 'ACTIVE') throw forbidden('Your admission is not active — please contact the office');
  req.student = s;
  next();
}

/** Signed-in admin / student of the current request (after the matching middleware). */
export const adminOf = (req: Request) => req.admin!;
export const studentOf = (req: Request) => req.student!;
