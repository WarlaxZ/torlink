import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Map a request path to a file inside `root`, or null if it escapes.
 *
 * Percent-decoding happens before the containment check, because a check on the
 * raw path would be defeated by `%2e%2e%2f`. The final guard is a prefix test on
 * the *resolved* absolute path, which is the only reliable way to prove
 * containment across platforms.
 */
export function resolveAssetPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes(" ")) return null;
  const rel = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "");
  if (!rel) return null;
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/**
 * Where the built browser assets live. tsup writes them to `dist/web`, so a
 * published install resolves relative to the bundle. A source run (`npm run
 * dev`) has no bundle, so fall back to the repo's own `dist/web` — meaning the
 * web UI needs `npm run build` once before `npm run dev --web` will serve it.
 */
export function findStaticDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "web"), // dist/index.js -> dist/web
    path.resolve(here, "../../dist/web"), // src/web/staticDir.ts -> dist/web
    path.resolve(here, "../dist/web"),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, "index.html"))) ?? null;
}
