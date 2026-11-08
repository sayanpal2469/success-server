/** Video id from any common YouTube link (watch, youtu.be, shorts, embed, live) or a bare id. */
export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return valid(u.pathname.slice(1));
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.searchParams.get('v')) return valid(u.searchParams.get('v')!);
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) return m[1]!;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

const valid = (id: string) => (/^[\w-]{11}$/.test(id) ? id : null);

export const youtubeThumb = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
