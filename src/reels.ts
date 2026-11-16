export interface ReelLink {
  originalUrl: string;
  canonicalUrl: string;
  shortcode: string;
}

const REEL_LINK_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/** Extracts only public Instagram Reel paths; no network request is made. */
export function extractReelLinks(text: string): ReelLink[] {
  const links = new Map<string, ReelLink>();

  for (const match of text.match(REEL_LINK_PATTERN) ?? []) {
    const originalUrl = match.replace(/[),.!?\]}]+$/g, '');
    try {
      const parsed = new URL(originalUrl);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (!['instagram.com', 'm.instagram.com'].includes(host)) continue;

      const path = parsed.pathname.match(/^\/(?:reel|reels)\/([A-Za-z0-9_-]+)\/?$/i);
      if (!path?.[1]) continue;

      const shortcode = path[1];
      const canonicalUrl = `https://www.instagram.com/reel/${shortcode}/`;
      if (!links.has(canonicalUrl)) links.set(canonicalUrl, { originalUrl, canonicalUrl, shortcode });
    } catch {
      // Ignore malformed URLs without reporting their contents.
    }
  }

  return [...links.values()];
}

export function isInstructionCommand(text: string): 'done' | 'cancel' | undefined {
  const command = text.trim().toLowerCase();
  if (command === '/done') return 'done';
  if (command === '/cancel') return 'cancel';
  return undefined;
}
