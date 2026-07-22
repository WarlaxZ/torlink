import { launch } from "./openFolder";

// Linux openers, tried in order — same set openFolder uses.
const LINUX_OPEN: [string, string[]][] = [
  ["xdg-open", []],
  ["gio", ["open"]],
];

// Open `url` in the platform's default browser. Never throws; false means the
// caller should tell the user it didn't work. Only http(s) URLs are accepted,
// so a stray value can't be coerced into launching an arbitrary local handler.
export async function openUrl(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  if (process.platform === "win32") {
    // explorer honors a URL too and exits non-zero even on success, so any
    // clean exit counts (mirrors openFolder's explorer handling).
    return launch("explorer", [url], true);
  }
  if (process.platform === "darwin") {
    return launch("open", [url]);
  }
  for (const [cmd, args] of LINUX_OPEN) {
    if (await launch(cmd, [...args, url])) return true;
  }
  return false;
}

// Build the canonical IMDb title-page URL for an imdbId (e.g. "tt123").
export function imdbTitleUrl(imdbId: string): string {
  return `https://www.imdb.com/title/${encodeURIComponent(imdbId)}/`;
}

// Build an IMDb search URL for a title — the best-effort fallback when we have
// a parsed name but no confident imdbId (e.g. an OMDb miss on a search result).
export function imdbFindUrl(query: string): string {
  return `https://www.imdb.com/find/?q=${encodeURIComponent(query)}`;
}
