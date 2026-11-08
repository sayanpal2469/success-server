import { Router } from 'express';

import { requireAdmin } from '../../lib/auth.js';
import { allRouter } from './all.js';
import { catalogRouter } from './catalog.js';
import { contentRouter } from './content.js';
import { enquiriesRouter } from './enquiries.js';
import { paymentsRouter } from './payments.js';
import { reportsRouter } from './reports.js';
import { scheduleRouter } from './schedule.js';
import { studentsRouter } from './students.js';
import { testsRouter } from './tests.js';

/** Everything under /api/v1/admin — the single admin role, no permission matrix. */
export const adminRouter = Router();
adminRouter.use(requireAdmin);
adminRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
adminRouter.use(allRouter, catalogRouter, studentsRouter, enquiriesRouter, paymentsRouter, testsRouter, scheduleRouter, contentRouter, reportsRouter);
