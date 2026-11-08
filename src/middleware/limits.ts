import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import { isTest } from '../config/env.js';

const make = (windowMin: number, limit: number, message: string, key?: (req: Request) => string, onlyFailures = false) =>
  rateLimit({
    windowMs: windowMin * 60_000,
    // Tests hammer the same endpoints from one IP; they get a roomier budget.
    limit: isTest ? limit * 50 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(key ? { keyGenerator: key } : {}),
    // Sign-in limits count wrong passwords only, so a student on several devices is never locked out.
    skipSuccessfulRequests: onlyFailures,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message } }),
  });

const ip = (req: Request) => ipKeyGenerator(req.ip ?? '0.0.0.0');
const loginKey = (field: string) => (req: Request) => `${ip(req)}|${String((req.body as Record<string, unknown> | undefined)?.[field] ?? '').toLowerCase()}`;

/** Wrong passwords: 10 tries per account per IP every 15 minutes, 50 per IP overall. */
export const adminLoginLimit = make(15, 10, 'Too many sign-in attempts — wait 15 minutes and try again', loginKey('email'), true);
/** Students sign in with `login` (email or Student ID); older app versions send `studentId`. */
const studentLoginKey = (req: Request) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  return `${ip(req)}|${String(b.login ?? b.studentId ?? '').toLowerCase()}`;
};
export const studentLoginLimit = make(15, 10, 'Too many sign-in attempts — wait 15 minutes and try again', studentLoginKey, true);
export const loginIpLimit = make(15, 50, 'Too many sign-in attempts from this network — try again later', undefined, true);
export const refreshLimit = make(15, 120, 'Too many requests — try again later');
/** Forgot password: codes asked for per email per IP, and code + new password tries. */
export const forgotLimit = make(60, 6, 'Too many code requests — wait a while and try again', loginKey('email'));
export const resetLimit = make(15, 15, 'Too many tries — wait 15 minutes and ask for a new code', loginKey('email'));
/** Public admission form and its uploads. */
export const applyLimit = make(60, 10, 'Too many admission requests from this network — try again later');
/** Enquiry and free-demo forms on the website. */
export const enquiryLimit = make(60, 15, 'Too many enquiries from this network — please call or WhatsApp us');
/** "Write a review" on the website. */
export const reviewLimit = make(60, 5, 'Too many reviews from this network — try again later');
export const uploadLimit = make(60, 40, 'Too many uploads from this network — try again later');
export const statusLimit = make(15, 30, 'Too many lookups — try again later');
export const statsLimit = make(1, 60, 'Too many requests');
