/**
 * The institute runs on India time. Calendar values (dates, months, class times) are stored as
 * plain strings — `YYYY-MM-DD`, `YYYY-MM`, `HH:mm` — in Asia/Kolkata; instants are UTC `Date`s.
 */
const IST_OFFSET_MIN = 330;

const pad = (n: number) => String(n).padStart(2, '0');

/** Wall-clock parts in India for an instant. */
function istParts(at: Date) {
  const d = new Date(at.getTime() + IST_OFFSET_MIN * 60_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), dow: d.getUTCDay() };
}

/** Today's date in India, `YYYY-MM-DD`. */
export function todayIST(at = new Date()) {
  const p = istParts(at);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Current time in India, `HH:mm`. */
export function nowTimeIST(at = new Date()) {
  const p = istParts(at);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

/** The instant a wall-clock India date + time happens. */
export function istInstant(date: string, time = '00:00') {
  return new Date(`${date}T${time}:00+05:30`);
}

export const monthKey = (date: string) => date.slice(0, 7);

/** Calendar maths on `YYYY-MM-DD` strings (UTC internally, so no DST/zone drift). */
export function addDays(date: string, n: number) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Validity end for an enrolment: `n` months later, minus a day (6 Apr + 12 → 5 Apr next year). */
export function addMonthsInclusive(date: string, n: number) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Every month key from one date's month to another's, inclusive. */
export function monthsBetween(from: string, to: string) {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number) as [number, number];
  const [ey, em] = to.slice(0, 7).split('-').map(Number) as [number, number];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${pad(m)}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Monday = 0 … Sunday = 6, as in the routine grid. */
export const weekday = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

/** Indian financial year of a date, e.g. `26-27` for 2026-10-09. */
export function financialYear(date: string) {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Academic session label used on report cards, e.g. `2026-27` (April → March). */
export function sessionOf(date: string) {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** First and last date of a session like `2026-27`. */
export function sessionRange(session: string) {
  const start = Number(session.slice(0, 4));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
