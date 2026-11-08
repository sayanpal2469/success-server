import mongoose from 'mongoose';

import { logger } from '../lib/logger.js';
import './plugin.js';

export async function connectDb(uri: string) {
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: true });
  // Build indexes up front (unique receipt numbers, one-payment-per-month) before taking traffic.
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export const disconnectDb = () => mongoose.disconnect();
