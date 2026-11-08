import { pino } from 'pino';

import { env, isProd, isTest } from '../config/env.js';

export const logger = pino({
  level: isTest ? (process.env.TEST_LOG ?? 'silent') : env.LOG_LEVEL,
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.refreshToken'], remove: true },
  ...(isProd || isTest ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }),
});
