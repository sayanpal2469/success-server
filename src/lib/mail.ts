import nodemailer, { type Transporter } from 'nodemailer';

import { env, isTest } from '../config/env.js';
import { LOGO_PNG } from '../mail/logo.js';
import { logger } from './logger.js';

export type Mail = { to: string; subject: string; html: string; text: string };

/** Emails "sent" while testing, newest last (tests read the OTP from here). */
export const outbox: Mail[] = [];

let transport: Transporter | null = null;
const configured = () => !!(env.SMTP_USER && env.SMTP_PASS);

function transporter() {
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return transport;
}

/**
 * Sends one email (with the logo attached inline as `cid:logo`). Never throws: a failed email must
 * not undo an admission or a password reset — the caller gets `false` and can tell the office.
 */
export async function sendMail(m: Mail): Promise<boolean> {
  if (isTest) {
    outbox.push(m);
    return true;
  }
  if (!configured()) {
    logger.warn({ to: m.to, subject: m.subject }, 'Email not sent: SMTP_USER / SMTP_PASS are not set');
    return false;
  }
  try {
    await transporter().sendMail({
      from: { name: env.MAIL_FROM_NAME, address: env.SMTP_USER },
      to: m.to,
      subject: m.subject,
      html: m.html,
      text: m.text,
      attachments: [{ filename: 'logo.png', content: LOGO_PNG, cid: 'logo', contentType: 'image/png' }],
    });
    return true;
  } catch (err) {
    logger.error({ err, to: m.to, subject: m.subject }, 'Email failed');
    return false;
  }
}
