import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentTypeFor, findStaticDir, resolveAssetPath } from "./staticDir";

const ROOT = path.resolve("/srv/dist/web");

describe("contentTypeFor", () => {
  it("maps the asset types the dashboard serves", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("styles.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("icon.svg")).toBe("image/svg+xml");
  });

  it("falls back to octet-stream for anything else", () => {
    expect(contentTypeFor("mystery.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("noextension")).toBe("application/octet-stream");
  });

  // Extension matching is case-insensitive so a build that emits APP.JS or
  // Index.HTML still gets a usable type instead of a download prompt.
  it("ignores extension case", () => {
    expect(contentTypeFor("APP.JS")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("Index.HTML")).toBe("text/html; charset=utf-8");
  });
});

describe("resolveAssetPath", () => {
  it("maps / to index.html", () => {
    expect(resolveAssetPath(ROOT, "/")).toBe(path.join(ROOT, "index.html"));
  });

  // Not all request-line parsers hand back a leading slash; an empty path means
  // the same thing as "/" and must not fall through to the empty-rel rejection.
  it("maps an empty path to index.html", () => {
    expect(resolveAssetPath(ROOT, "")).toBe(path.join(ROOT, "index.html"));
  });

  it("resolves a normal asset", () => {
    expect(resolveAssetPath(ROOT, "/app.js")).toBe(path.join(ROOT, "app.js"));
  });

  it("rejects traversal out of the asset root", () => {
    expect(resolveAssetPath(ROOT, "/../../etc/passwd")).toBeNull();
    expect(resolveAssetPath(ROOT, "/..%2f..%2fetc/passwd")).toBeNull();
  });

  // A leading-slash-stripped path is NOT an escape: it lands inside the asset
  // root and simply 404s. Asserting null here would be asserting the wrong
  // thing — what matters is containment, not rejection.
  it("contains a leading-double-slash path inside the root", () => {
    expect(resolveAssetPath(ROOT, "//etc/passwd")).toBe(path.join(ROOT, "etc/passwd"));
  });

  // The containment check must compare against `root + separator`, not `root`.
  // A bare prefix test would accept a *sibling* directory whose name starts with
  // the root's name, which is a real escape: /srv/dist/web-evil is not inside
  // /srv/dist/web even though its path begins with those characters.
  it("rejects a sibling directory that shares the root's prefix", () => {
    expect(resolveAssetPath(ROOT, "/../web-evil/secret")).toBeNull();
    expect(resolveAssetPath(ROOT, "/../web.bak/secret")).toBeNull();
  });

  // Traversal that starts by descending is still traversal: `path.resolve`
  // collapses the segments, so the guard has to run on the collapsed result.
  it("rejects traversal that first descends into a real asset", () => {
    expect(resolveAssetPath(ROOT, "/index.html/../../../etc/passwd")).toBeNull();
  });

  // Collapsing happens *inside* the root too — /a/../app.js is just /app.js.
  it("normalises interior traversal that stays inside the root", () => {
    expect(resolveAssetPath(ROOT, "/./app.js")).toBe(path.join(ROOT, "app.js"));
    expect(resolveAssetPath(ROOT, "/a/../app.js")).toBe(path.join(ROOT, "app.js"));
  });

  // Requiring the separator in the prefix test means the root directory itself
  // fails containment, which is what we want: every caller wants a *file*, and
  // handing back a directory only converts a 404 into an EISDIR throw. `/` still
  // works because it is mapped to index.html before the guard runs.
  it("rejects a path that resolves to the root directory itself", () => {
    expect(resolveAssetPath(ROOT, "/.")).toBeNull();
    expect(resolveAssetPath(ROOT, "/index.html/..")).toBeNull();
  });

  it("rejects a path that is nothing but slashes", () => {
    expect(resolveAssetPath(ROOT, "//")).toBeNull();
  });

  // These are rejected to satisfy fs's contract, not to stop traversal. The NUL
  // case is the one that matters: fs throws a TypeError (ERR_INVALID_ARG_VALUE)
  // for an embedded NUL rather than setting err.code, so without this filter a
  // request for /app.js%00.png escapes a caller's ENOENT handling as a 500. It
  // would also be served as image/png while naming a .js file.
  it("rejects control characters that fs cannot accept", () => {
    expect(resolveAssetPath(ROOT, "/app.js%00.png")).toBeNull();
    expect(resolveAssetPath(ROOT, "/%00")).toBeNull();
    expect(resolveAssetPath(ROOT, "/%09app.js")).toBeNull();
    expect(resolveAssetPath(ROOT, "/app.js%0a")).toBeNull();
    expect(resolveAssetPath(ROOT, "/app.js%0d%0aX-Evil:%201")).toBeNull();
  });

  // A space is in the same rejected class, but for tidiness rather than safety:
  // it cannot form a separator or a `..` segment. The cost is that an asset
  // legitimately named "my file.css" is unreachable — rename it in the build.
  it("rejects a path containing a space", () => {
    expect(resolveAssetPath(ROOT, "/app.js .png")).toBeNull();
    expect(resolveAssetPath(ROOT, "/my%20file.css")).toBeNull();
  });

  // Printable characters above the control range are untouched by the filter.
  it("allows unusual but printable filenames", () => {
    expect(resolveAssetPath(ROOT, "/app-2.0_x%2Bb.js")).toBe(path.join(ROOT, "app-2.0_x+b.js"));
  });

  it("rejects a malformed percent escape", () => {
    expect(resolveAssetPath(ROOT, "/%ZZ")).toBeNull();
  });
});

describe("findStaticDir", () => {
  // `here` mimics a published install: dist/index.js looks for dist/web.
  const DIST = path.resolve("/opt/torlink/dist");

  it("prefers the bundle-relative directory", () => {
    const found = findStaticDir((p) => p === path.join(DIST, "web", "index.html"), DIST);
    expect(found).toBe(path.join(DIST, "web"));
  });

  it("falls back to the repo's dist/web for a source run", () => {
    // here = <repo>/src/web, so ../../dist/web is <repo>/dist/web.
    const SRC = path.resolve("/repo/src/web");
    const target = path.resolve("/repo/dist/web");
    const found = findStaticDir((p) => p === path.join(target, "index.html"), SRC);
    expect(found).toBe(target);
  });

  it("takes the first candidate when several would match", () => {
    const SRC = path.resolve("/repo/src/web");
    const found = findStaticDir(() => true, SRC);
    expect(found).toBe(path.join(SRC, "web"));
  });

  it("ignores a directory that exists without index.html", () => {
    // A partial build leaves the *directory* present but empty. That must not
    // match, and must not shadow a later candidate that is complete — so the
    // earlier candidate's directory exists here while only the later one has the
    // sentinel file inside it.
    const SRC = path.resolve("/repo/src/web");
    const empty = path.join(SRC, "web");
    const complete = path.resolve("/repo/dist/web");
    const found = findStaticDir(
      (p) => p === empty || p === path.join(complete, "index.html"),
      SRC,
    );
    expect(found).toBe(complete);
  });

  it("returns null when no candidate has been built", () => {
    expect(findStaticDir(() => false, path.resolve("/repo/src/web"))).toBeNull();
  });
});
