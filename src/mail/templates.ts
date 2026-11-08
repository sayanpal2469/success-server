import { getSettings } from '../models/org.js';

/**
 * Branded emails: logo, institute name, a white card on a light background, and the institute's
 * address and phone in the footer. Inline styles and tables only, so Gmail and phone mail apps show
 * them the same way. Every email also has a plain-text version.
 */

const BLUE = '#1F2FD6';
const INK = '#0F1222';
const MUTED = '#5B6078';

// Shown when Website › Contact is still empty (the institute's printed details).
const FALLBACK = { address: 'Munshirhat, Howrah – 711410', phone: '6296264592', email: 'successtutorialsofficial@gmail.com' };

type Brand = { name: string; address: string; phone: string; email: string };

export async function brand(): Promise<Brand> {
  const s = await getSettings();
  const c = (s.contact ?? {}) as { address?: string; phone?: string; email?: string };
  const address = c.address?.trim() && c.address !== 'Howrah, West Bengal' ? c.address : FALLBACK.address;
  return { name: s.instituteName || 'Success Tutorials', address, phone: c.phone?.trim() || FALLBACK.phone, email: c.email?.trim() || FALLBACK.email };
}

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function layout(b: Brand, title: string, body: string) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#EEF1FB;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1FB;padding:28px 12px">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td align="center" style="padding:0 0 18px">
      <img src="cid:logo" width="72" height="72" alt="${esc(b.name)}" style="display:block;border:0;width:72px;height:72px">
      <div style="margin-top:10px;font-size:20px;font-weight:800;letter-spacing:.3px;color:${INK}">${esc(b.name)}</div>
    </td></tr>
    <tr><td style="background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(15,18,34,.08)">
      <div style="height:5px;background:linear-gradient(90deg,#E53935 0 33%,${BLUE} 33% 66%,#0F1222 66%)"></div>
      <div style="padding:30px 30px 28px">${body}</div>
    </td></tr>
    <tr><td align="center" style="padding:20px 10px 0;font-size:12.5px;line-height:1.6;color:${MUTED}">
      ${esc(b.name)} · ${esc(b.address)}<br>
      Call ${esc(b.phone)} · <a href="mailto:${esc(b.email)}" style="color:${MUTED}">${esc(b.email)}</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

const h1 = (t: string) => `<h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;font-weight:800;color:${INK}">${t}</h1>`;
const p = (t: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#2A2F45">${t}</p>`;
const small = (t: string) => `<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:${MUTED}">${t}</p>`;

/** Label / value rows in a tinted box (sign-in details). */
const details = (rows: [string, string][]) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;background:#F4F6FF;border:1px solid #DDE2FB;border-radius:12px">
  ${rows
    .map(
      ([k, v], i) =>
        `<tr><td style="padding:12px 16px;${i ? 'border-top:1px solid #DDE2FB;' : ''}font-size:13px;color:${MUTED};width:130px">${esc(k)}</td><td style="padding:12px 16px;${i ? 'border-top:1px solid #DDE2FB;' : ''}font-size:15px;font-weight:700;color:${INK};font-family:Consolas,'Courier New',monospace">${esc(v)}</td></tr>`,
    )
    .join('')}
</table>`;

/* ───────────────────────── Student: welcome ───────────────────────── */

export async function welcomeEmail(s: { name: string; email: string; studentId: string; className: string; password?: string }) {
  const b = await brand();
  const first = s.name.split(' ')[0] ?? s.name;
  const rows: [string, string][] = [
    ['Student ID', s.studentId],
    ['Class', s.className],
    ['Login email', s.email],
    ...(s.password ? ([['Password', s.password]] as [string, string][]) : []),
  ];
  const html = layout(
    b,
    `Welcome to ${b.name}`,
    `${h1(`Welcome to ${esc(b.name)}, ${esc(first)}! 🎉`)}
     ${p(`Your admission is confirmed. We’re glad to have you with us — let’s make this year your best one yet.`)}
     ${p(`Sign in to the <b>${esc(b.name)}</b> app to see your routine, notices, fees, exams and results:`)}
     ${details(rows)}
     ${s.password ? p(`Please change this password after you sign in (Profile › Change password). Keep it private.`) : p(`Sign in with this email and the password you chose when you applied.`)}
     ${small(`Forgot the password later? Tap “Forgot password” in the app — we’ll email you a code to set a new one.`)}`,
  );
  const text = [
    `Welcome to ${b.name}, ${first}!`,
    `Your admission is confirmed.`,
    ``,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ``,
    s.password ? 'Please change this password after you sign in.' : 'Sign in with this email and the password you chose when you applied.',
    `Forgot it later? Tap "Forgot password" in the app.`,
    ``,
    `${b.name} · ${b.address} · ${b.phone}`,
  ].join('\n');
  return { to: s.email, subject: `Welcome to ${b.name} — your login details`, html, text };
}

/* ───────────────────────── Password reset code ───────────────────────── */

export async function otpEmail(o: { to: string; name: string; code: string; minutes: number; panel: 'app' | 'admin panel' }) {
  const b = await brand();
  const digits = o.code
    .split('')
    .map((d) => `<td style="width:44px;height:52px;background:#F4F6FF;border:1px solid #DDE2FB;border-radius:10px;text-align:center;font-size:26px;font-weight:800;color:${BLUE};font-family:Consolas,'Courier New',monospace">${d}</td>`)
    .join('<td style="width:8px"></td>');
  const html = layout(
    b,
    'Your password reset code',
    `${h1('Reset your password')}
     ${p(`Hi ${esc(o.name.split(' ')[0] ?? o.name)}, use this code to set a new password for the ${b.name} ${o.panel}:`)}
     <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px"><tr>${digits}</tr></table>
     ${p(`The code works for <b>${o.minutes} minutes</b> and only once.`)}
     ${small(`Didn’t ask for this? Ignore this email — your password stays the same. Never share this code with anyone, not even the office.`)}`,
  );
  const text = [`Reset your ${b.name} password`, ``, `Your code: ${o.code}`, `It works for ${o.minutes} minutes and only once.`, ``, `Didn't ask for this? Ignore this email — your password stays the same.`].join('\n');
  return { to: o.to, subject: `${o.code} is your ${b.name} password reset code`, html, text };
}

/* ───────────────────────── Student: new password from the office ───────────────────────── */

export async function newPasswordEmail(s: { name: string; email: string; studentId: string; password: string }) {
  const b = await brand();
  const html = layout(
    b,
    'Your new password',
    `${h1('Your password was reset')}
     ${p(`Hi ${esc(s.name.split(' ')[0] ?? s.name)}, the office has set a new password for your ${esc(b.name)} app. You were signed out on all phones.`)}
     ${details([
       ['Login email', s.email],
       ['Student ID', s.studentId],
       ['New password', s.password],
     ])}
     ${p(`Please change it after you sign in (Profile › Change password).`)}
     ${small(`Didn’t ask for this? Call the office on ${esc(b.phone)}.`)}`,
  );
  const text = [`Your ${b.name} password was reset by the office.`, ``, `Login email: ${s.email}`, `Student ID: ${s.studentId}`, `New password: ${s.password}`, ``, `Please change it after you sign in.`].join('\n');
  return { to: s.email, subject: `Your new ${b.name} app password`, html, text };
}
