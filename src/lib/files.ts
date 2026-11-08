import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { Request } from 'express';
import multer from 'multer';

import { env } from '../config/env.js';
import { badRequest } from './errors.js';
import { safeEqual } from './auth.js';

/**
 * Two folders under UPLOAD_DIR:
 *   public/  — photos, banners, course covers, course PDFs and videos. Served at /uploads/<name>;
 *              names are 128-bit random so they can't be guessed.
 *   private/ — admission documents (Aadhaar scans …). Served only through short-lived signed
 *              links (/files/<name>?exp&sig) that admin endpoints hand out.
 */
export const UPLOAD_ROOT = path.resolve(env.UPLOAD_DIR);
export const PUBLIC_DIR = path.join(UPLOAD_ROOT, 'public');
export const PRIVATE_DIR = path.join(UPLOAD_ROOT, 'private');
mkdirSync(PUBLIC_DIR, { recursive: true });
mkdirSync(PRIVATE_DIR, { recursive: true });

export type FileKind = 'image' | 'pdf' | 'video' | 'doc' | 'answer';

const TYPES: Record<FileKind, { mime: string[]; max: number }> = {
  image: { mime: ['image/jpeg', 'image/png', 'image/webp'], max: 5 * 1024 * 1024 },
  pdf: { mime: ['application/pdf'], max: 40 * 1024 * 1024 },
  video: { mime: ['video/mp4', 'video/webm'], max: 1024 * 1024 * 1024 },
  /** Admission documents: a photo or scan of a card, or a PDF. */
  doc: { mime: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], max: 8 * 1024 * 1024 },
  /** Written exam answer sheet: photos of the notebook made into one PDF in the app. */
  answer: { mime: ['application/pdf'], max: 40 * 1024 * 1024 },
};

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

/** Leading bytes of each allowed type — the client's Content-Type alone isn't trusted. */
function sniff(head: Buffer): string | null {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
  return null;
}

/** Multer middleware for one `file` field of the given kind. */
export function uploader(kind: FileKind, visibility: 'public' | 'private') {
  const t = TYPES[kind];
  return multer({
    storage: multer.diskStorage({
      destination: visibility === 'public' ? PUBLIC_DIR : PRIVATE_DIR,
      filename: (_req, file, cb) => cb(null, `${randomBytes(16).toString('hex')}${EXT[file.mimetype] ?? ''}`),
    }),
    limits: { fileSize: t.max, files: 1, fields: 5 },
    fileFilter: (_req, file, cb) => (t.mime.includes(file.mimetype) ? cb(null, true) : cb(badRequest(`This file type is not allowed here (${t.mime.join(', ')})`))),
  }).single('file');
}

/** Checks the stored file's real type, then describes it. Deletes it if it isn't what it claims. */
export async function acceptUpload(req: Request, visibility: 'public' | 'private') {
  const f = req.file;
  if (!f) throw badRequest('Attach a file in the "file" field');
  const fh = await open(f.path, 'r');
  const head = Buffer.alloc(16);
  await fh.read(head, 0, 16, 0);
  await fh.close();
  const real = sniff(head);
  const sameFamily = real === f.mimetype || (real === 'video/mp4' && f.mimetype.startsWith('video/'));
  if (!sameFamily) {
    await unlink(f.path).catch(() => {});
    throw badRequest('The file content does not match its type');
  }
  const url = visibility === 'public' ? `/uploads/${f.filename}` : `/files/${f.filename}`;
  return { url, name: f.originalname.slice(0, 200), size: f.size, type: f.mimetype };
}

/* ───────────────────────── Signed links for private files ───────────────────────── */

const sig = (name: string, exp: number) => createHmac('sha256', env.JWT_ACCESS_SECRET).update(`file:${name}:${exp}`).digest('base64url');

/** `/files/<name>` → `/files/<name>?exp=…&sig=…`, valid for `minutes`. Other values pass through. */
export function signFileUrl(url: string | undefined | null, minutes = 30) {
  if (!url || !url.startsWith('/files/')) return url ?? undefined;
  const name = url.slice('/files/'.length).split('?')[0]!;
  const exp = Math.floor(Date.now() / 1000) + minutes * 60;
  return `/files/${name}?exp=${exp}&sig=${sig(name, exp)}`;
}

export function checkFileSig(name: string, exp: string | undefined, s: string | undefined) {
  const e = Number(exp);
  if (!/^[a-f0-9]{32}\.[a-z0-9]{3,4}$/.test(name) || !Number.isFinite(e) || e < Date.now() / 1000 || !s) return false;
  return safeEqual(sig(name, e), s);
}

const DOC_KEYS = ['aadhaarFront', 'aadhaarBack', 'birthCertificate', 'marksheet'] as const;

/** Admission documents with signed links, for admin responses (accepts a Mongoose subdocument or plain object). */
export function signDocuments(d: unknown): Partial<Record<(typeof DOC_KEYS)[number], string>> {
  if (!d || typeof d !== 'object') return {};
  const src = d as Record<string, unknown>;
  const out: Partial<Record<(typeof DOC_KEYS)[number], string>> = {};
  for (const k of DOC_KEYS) if (typeof src[k] === 'string' && src[k]) out[k] = signFileUrl(src[k] as string);
  return out;
}

/** Deletes a stored upload (`/uploads/<name>` or `/files/<name>`, signed links too); missing files are ignored. */
export async function removeStoredFile(url: string | undefined | null) {
  const m = url?.match(/^\/(uploads|files)\/([a-f0-9]{32}\.[a-z0-9]{3,4})(\?.*)?$/);
  if (!m) return;
  await unlink(path.join(m[1] === 'uploads' ? PUBLIC_DIR : PRIVATE_DIR, m[2]!)).catch(() => {});
}
