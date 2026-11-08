/**
 * npm run seed            → admin account, settings, classes & subjects with fees, extra curriculums,
 *                           sample website reviews / gallery / blog / FAQs (only into empty collections)
 * npm run seed -- --demo  → also a full demo dataset (students, payments, exams, attendance …; see demo.ts)
 * npm run seed -- --reset --demo → wipe all data (admin accounts kept) and load the demo again
 *
 * Without --reset it is safe to run again: nothing is duplicated or deleted.
 */
import mongoose from 'mongoose';
import { z } from 'zod';

import { env } from '../config/env.js';
import { connectDb } from '../db/connect.js';
import { hashPassword } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { ClassDef, Extra } from '../models/catalog.js';
import { Admin, Settings } from '../models/org.js';
import { classes, contact, extras } from './data.js';
import { seedWebsiteContent } from './content.js';
import { seedDemo } from './demo.js';

const seedEnv = z
  .object({
    SEED_ADMIN_NAME: z.string().min(1).default('Admin'),
    SEED_ADMIN_EMAIL: z.string().email(),
    SEED_ADMIN_PASSWORD: z.string().min(8, 'SEED_ADMIN_PASSWORD must be at least 8 characters'),
  })
  .parse(process.env);

async function base() {
  const email = seedEnv.SEED_ADMIN_EMAIL.toLowerCase();
  if (!(await Admin.exists({ email }))) {
    await Admin.create({ name: seedEnv.SEED_ADMIN_NAME, email, passwordHash: await hashPassword(seedEnv.SEED_ADMIN_PASSWORD) });
    logger.info({ email }, 'admin created');
  } else logger.info({ email }, 'admin exists — password left unchanged');

  await Settings.updateOne(
    { _id: 'main' },
    { $setOnInsert: { instituteName: 'Success Tutorials', centerHead: seedEnv.SEED_ADMIN_NAME, idPrefix: 'ST26-', defaultDurationMonths: 12, admissionOpen: true, dueDay: 10, contact } },
    { upsert: true },
  );
  for (const c of classes) await ClassDef.updateOne({ _id: c._id }, { $setOnInsert: c }, { upsert: true });
  for (const e of extras) await Extra.updateOne({ _id: e._id }, { $setOnInsert: e }, { upsert: true });
  logger.info({ classes: classes.length, extras: extras.length }, 'catalog ready');
  await seedWebsiteContent();
}

/** Wipes everything except admin accounts (for `--reset`). */
async function reset() {
  const keep = new Set(['admins']);
  for (const c of await mongoose.connection.db!.listCollections().toArray()) {
    if (!keep.has(c.name)) await mongoose.connection.db!.collection(c.name).deleteMany({});
  }
  logger.warn('all data wiped (admin accounts kept)');
}

await connectDb(env.MONGODB_URI);
try {
  if (process.argv.includes('--reset')) await reset();
  await base();
  if (process.argv.includes('--demo')) await seedDemo();
  logger.info('seed finished');
} finally {
  await mongoose.disconnect();
}
