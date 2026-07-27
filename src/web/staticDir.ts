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
  // An input filter for fs's contract, NOT a traversal defence — containment is
  // proven solely by the prefix test below, and no character in this class can
  // produce a separator or a `..` segment. It earns its place because `fs`
  // rejects a NUL byte with a *TypeError* (ERR_INVALID_ARG_VALUE) rather than an
  // errno, so `%00` would sail past a caller's `if (err.code === "ENOENT")` and
  // surface as a 500. Rejecting the whole control range costs nothing extra.
  if (/[\u0000-\u0020]/.test(decoded)) return null;
  const rel = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "");
  if (!rel) return null;
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  // `base + path.sep`, never bare `base`: a bare prefix test would admit the
  // sibling /srv/dist/web-evil for a root of /srv/dist/web. Requiring the
  // separator also means `full === base` fails, so a path resolving to the
  // directory itself (`/.`) is rejected rather than handed back as a file — `/`
  // is unaffected because it became index.html above.
  if (!full.startsWith(base + path.sep)) return null;
  return full;
}

/**
 * Where the built browser assets live. tsup writes them to `dist/web`, so a
 * published install resolves relative to the bundle. A source run (`npm run
 * dev`) has no bundle, so fall back to the repo's own `dist/web` — meaning the
 * web UI needs `npm run build` once before `npm run dev --web` will serve it.
 *
 * `exists` and `here` are injected only so this is testable. A fixture cannot
 * reach it otherwise: the candidates derive from `import.meta.url`, which is
 * fixed at this file's location, so no temp directory can ever make one hit.
 */
export function findStaticDir(
  exists: (p: string) => boolean = existsSync,
  here: string = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
  const candidates = [
    path.join(here, "web"), // dist/index.js -> dist/web
    path.resolve(here, "../../dist/web"), // src/web/staticDir.ts -> dist/web
    path.resolve(here, "../dist/web"),
  ];
  // index.html specifically, not the directory: a `dist/web` left behind by a
  // failed or partial build exists but serves nothing, and matching it would
  // shadow a later candidate that is actually complete.
  return candidates.find((dir) => exists(path.join(dir, "index.html"))) ?? null;
}
