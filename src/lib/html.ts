/**
 * Light clean-up of HTML written in the admin's rich-text editor before it is stored: no scripts,
 * embedded frames, inline event handlers or `javascript:` links.
 */
export function cleanHtml(html: string) {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|form|meta|link)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*(javascript|data|vbscript):[^"'\s>]*\2/gi, '$1="#"');
}

/** Reading time for a post, at ~200 words a minute. */
export const readingMinutes = (html: string) => Math.max(1, Math.round(html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length / 200));

/** "Madhyamik 2027: a study plan" → "madhyamik-2027-a-study-plan". */
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 80) || 'post';
