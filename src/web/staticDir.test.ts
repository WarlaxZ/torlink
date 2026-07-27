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
  });
});

describe("resolveAssetPath", () => {
  it("maps / to index.html", () => {
    expect(resolveAssetPath(ROOT, "/")).toBe(path.join(ROOT, "index.html"));
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

  it("rejects a path containing a space", () => {
    expect(resolveAssetPath(ROOT, "/app.js .png")).toBeNull();
  });

  it("rejects a malformed percent escape", () => {
    expect(resolveAssetPath(ROOT, "/%ZZ")).toBeNull();
  });
});
