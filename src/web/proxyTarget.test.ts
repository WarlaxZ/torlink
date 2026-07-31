import { describe, expect, it } from "vitest";
import {
  HTTP_AND_HTTPS,
  HTTP_ONLY,
  resolveProxyTarget,
  resolveRedirect,
} from "./proxyTarget";

describe("resolveProxyTarget", () => {
  it("accepts an http url when http is allowed", () => {
    const t = resolveProxyTarget("http://127.0.0.1:5000/webtorrent/a", HTTP_ONLY, 3);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url.hostname).toBe("127.0.0.1");
  });

  it("refuses https when only http is allowed — the WebTorrent invariant", () => {
    // This is the check that exists today and must keep existing: the local
    // backend serves plain http on loopback and nothing else.
    expect(resolveProxyTarget("https://cdn.example/a.mkv", HTTP_ONLY, 3)).toEqual({
      ok: false,
      reason: "scheme",
    });
  });

  it("accepts https when https is allowed — the debrid case", () => {
    const t = resolveProxyTarget("https://cdn.example/a.mkv", HTTP_AND_HTTPS, 3);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url.protocol).toBe("https:");
  });

  it.each(["file:///etc/passwd", "ftp://host/x", "data:text/plain,hi", "gopher://h/1"])(
    "refuses %s even with both http schemes allowed",
    (target) => {
      expect(resolveProxyTarget(target, HTTP_AND_HTTPS, 3)).toEqual({
        ok: false,
        reason: "scheme",
      });
    },
  );

  it("refuses an unparseable target", () => {
    expect(resolveProxyTarget("not a url", HTTP_AND_HTTPS, 3)).toEqual({
      ok: false,
      reason: "unparseable",
    });
  });

  it("refuses when the hop budget is exhausted", () => {
    expect(resolveProxyTarget("https://cdn.example/a.mkv", HTTP_AND_HTTPS, 0)).toEqual({
      ok: false,
      reason: "hops",
    });
  });
});

describe("resolveRedirect", () => {
  const from = new URL("https://cdn.example/d/TOKEN/Kestrel.2010.1080p.BluRay.x264.mkv");

  it("resolves an absolute redirect", () => {
    const t = resolveRedirect("https://node7.cdn.example/x.mkv", from, HTTP_AND_HTTPS, 2);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url.hostname).toBe("node7.cdn.example");
  });

  it("resolves a path-relative redirect against the previous url", () => {
    // Providers do send these, and treating one as absolute yields a request to
    // a hostname that does not exist.
    const t = resolveRedirect("/other/path.mkv", from, HTTP_AND_HTTPS, 2);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url.href).toBe("https://cdn.example/other/path.mkv");
  });

  it("refuses a redirect that changes to a scheme we do not allow", () => {
    // A redirect is attacker-influenced in exactly the way the original URL is
    // not: it comes from the response, so the allow-list has to be re-applied.
    expect(resolveRedirect("file:///etc/passwd", from, HTTP_AND_HTTPS, 2)).toEqual({
      ok: false,
      reason: "scheme",
    });
  });

  it("refuses once the budget runs out", () => {
    expect(resolveRedirect("https://node7.cdn.example/x", from, HTTP_AND_HTTPS, 0)).toEqual({
      ok: false,
      reason: "hops",
    });
  });

  it("refuses an unparseable location", () => {
    expect(resolveRedirect("http://[bad", from, HTTP_AND_HTTPS, 2)).toEqual({
      ok: false,
      reason: "unparseable",
    });
  });
});
