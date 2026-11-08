import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { logger } from './lib/logger.js';

// Listen first so the host sees the app up (and /health answers) while MongoDB connects.
const server = createApp().listen(env.PORT, () => logger.info(`API listening on ${env.PORT}`));

connectDb(env.MONGODB_URI).catch((err) => {
  logger.fatal({ err }, 'MongoDB connection failed — check MONGODB_URI and Atlas Network Access');
  process.exit(1);
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    disconnectDb().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
