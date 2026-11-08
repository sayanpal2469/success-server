/**
 * Production entry: `node server.js` (after `npm run build`).
 *
 * Hosts usually set the environment variables in their dashboard; a local `.env` is read only when
 * it exists. The app is imported after that so its config sees the variables. No top-level await
 * here: some hosts (LiteSpeed / Passenger) load this file with require().
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('./.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

import('./dist/server.js').catch((err) => {
  console.error('API failed to start:', err);
  process.exit(1);
});
