import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { inject } from 'vitest';

// Must run before any src module reads the environment.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = inject('mongoUri').replace(/\/(\?|$)/, `/st_test_${process.pid}$1`);
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret-0123456789';
process.env.CORS_ORIGINS = 'http://localhost:5174';
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), 'st-uploads-'));
process.env.LOG_LEVEL = 'silent';
