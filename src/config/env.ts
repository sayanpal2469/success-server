import { z } from 'zod';

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // A number, or a socket path on hosts like LiteSpeed / Passenger.
  PORT: z
    .string()
    .default('4100')
    .transform((p) => (/^\d+$/.test(p) ? Number(p) : p)),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  ADMIN_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  STUDENT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(180),
  CORS_ORIGINS: z.string().default('').transform(list),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  UPLOAD_DIR: z.string().default('./uploads'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Outgoing email (welcome emails, password-reset codes). Without SMTP_USER/PASS nothing is sent. */
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM_NAME: z.string().default('Success Tutorials'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${lines}`);
  }
  const env = parsed.data;
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  if (env.NODE_ENV === 'production' && /change-me/.test(env.JWT_ACCESS_SECRET + env.JWT_REFRESH_SECRET)) {
    throw new Error('Replace the example JWT secrets before running in production');
  }
  return env;
}

export const env = load();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
