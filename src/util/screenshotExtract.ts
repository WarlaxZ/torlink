// Pull screenshot image URLs out of the two adult sources' descriptions. Pure:
// no network, no node:* — the fetching lives in core/screenshots.ts. Grounded in
// a 2026-08-12 spike of real apibay + 1337x data (see the design doc for hosts).
//
// The host allowlist is the single SSRF gate: core/screenshots.ts and the image
// proxy both consult it before issuing any request, so an off-list URL in a
// stranger's description is never fetched.

export interface Shot {
  thumb: string;
  full: string;
}

// Exact-host membership (not suffix) so "trafficimage.club.evil.example" fails
// closed. Chevereto image hosts (trafficimage/starimage) plus the direct hosts
// 1337x links to. Extend as new hosts appear — until then they degrade to the
// breakdown-only pane.
export const SCREENSHOT_HOSTS = new Set([
  "imgtraffic.com",
  "shotcan.com",
  "pixfy.cfd",
  "trafficimage.club",
  "starimage.club",
  "s.starimage.club",
  "xxxwebdlxxx.org",
]);

export function screenshotHostAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return SCREENSHOT_HOSTS.has(parsed.hostname.toLowerCase());
}

// Every http(s) URL in the text, allowlisted. TPB descrs list screenshots as
// bare landing-page URLs (and occasionally bbcode), so match URLs broadly and
// let the allowlist do the narrowing.
export function extractTpbLandings(descr: string): string[] {
  const urls = descr.match(/https?:\/\/[^\s"'<>\])]+/gi) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (seen.has(u) || !screenshotHostAllowed(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

// A landing page → its direct image, via og:image (the Chevereto hosts all set
// it). Allowlisted so a landing page can't point us off-list.
export function directFromLandingHtml(html: string): string | null {
  const m =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  const url = m?.[1]?.trim();
  if (!url || !screenshotHostAllowed(url)) return null;
  return url;
}

// A 1337x detail page carries direct image URLs in <img src>. Allowlist filters
// out site chrome (logos, avatars) without a hand-maintained deny list.
export function extract1337xImages(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const u = m[1]!;
    if (seen.has(u) || !screenshotHostAllowed(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

// A smaller variant for the strip. Chevereto exposes "<name>.md.jpg" beside
// "<name>.jpg"; other hosts have no known scheme, so use the URL as-is.
const CHEVERETO_THUMB_HOSTS = new Set(["trafficimage.club", "starimage.club", "s.starimage.club"]);
export function thumbFor(directUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(directUrl);
  } catch {
    return directUrl;
  }
  if (CHEVERETO_THUMB_HOSTS.has(parsed.hostname.toLowerCase())) {
    return directUrl.replace(/\.(jpe?g|png|webp)(\?.*)?$/i, ".md.$1$2");
  }
  return directUrl;
}
