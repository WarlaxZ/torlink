import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentTypeFor, resolveAssetPath } from "./staticDir";

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

  // A path resolving to the root *directory* is contained, so the guard permits
  // it and it is returned unchanged rather than rewritten to index.html (only a
  // literally empty path gets that treatment). Callers must therefore be ready
  // for a directory here: reading it yields EISDIR, not a 404.
  it("returns the root itself for a path that resolves to it", () => {
    expect(resolveAssetPath(ROOT, "/.")).toBe(ROOT);
  });

  it("rejects a path that is nothing but slashes", () => {
    expect(resolveAssetPath(ROOT, "//")).toBeNull();
  });

  it("rejects a path containing a space", () => {
    expect(resolveAssetPath(ROOT, "/app.js .png")).toBeNull();
  });

  it("rejects a malformed percent escape", () => {
    expect(resolveAssetPath(ROOT, "/%ZZ")).toBeNull();
  });
});
