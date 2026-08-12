import { describe, it, expect } from "vitest";
import {
  screenshotHostAllowed,
  extractTpbLandings,
  directFromLandingHtml,
  extract1337xImages,
  thumbFor,
} from "./screenshotExtract";

describe("screenshotHostAllowed", () => {
  it("allows the verified hosts and rejects everything else", () => {
    expect(screenshotHostAllowed("https://trafficimage.club/image/HYtPsz")).toBe(true);
    expect(screenshotHostAllowed("https://imgtraffic.com/1s/2026/07/30/a.jpeg")).toBe(true);
    expect(screenshotHostAllowed("https://evil.example/x.jpg")).toBe(false);
    // exact-host, so a look-alike suffix fails closed
    expect(screenshotHostAllowed("https://trafficimage.club.evil.example/x")).toBe(false);
    expect(screenshotHostAllowed("ftp://trafficimage.club/x")).toBe(false);
    expect(screenshotHostAllowed("not a url")).toBe(false);
  });
});

describe("extractTpbLandings", () => {
  it("pulls landing-page URLs from a TPB descr, allowlisted only", () => {
    const descr =
      "Meridian Studios 2026\n" +
      "https://trafficimage.club/image/HY8wM4\n" +
      "https://s.starimage.club/image/Yamk\n" +
      "https://xxxwebdlxxx.org/img-6a7a01cb6b01d.html\n" +
      "https://tracker.evil.example/announce";
    expect(extractTpbLandings(descr)).toEqual([
      "https://trafficimage.club/image/HY8wM4",
      "https://s.starimage.club/image/Yamk",
      "https://xxxwebdlxxx.org/img-6a7a01cb6b01d.html",
    ]);
  });
  it("returns nothing for a descr with no landing links", () => {
    expect(extractTpbLandings("just some text, no links")).toEqual([]);
  });
});

describe("directFromLandingHtml", () => {
  it("reads the og:image direct URL", () => {
    const html =
      '<meta property="og:image" content="https://trafficimage.club/images/2026/08/11/abc.jpg">';
    expect(directFromLandingHtml(html)).toBe("https://trafficimage.club/images/2026/08/11/abc.jpg");
  });
  it("returns null when there is no og:image", () => {
    expect(directFromLandingHtml("<html><body>no meta</body></html>")).toBeNull();
  });
  it("ignores an og:image on a non-allowlisted host", () => {
    const html = '<meta property="og:image" content="https://evil.example/x.jpg">';
    expect(directFromLandingHtml(html)).toBeNull();
  });
});

describe("extract1337xImages", () => {
  it("pulls direct image URLs from a detail page, filtering site chrome", () => {
    const html =
      '<img src="https://imgtraffic.com/1s/2026/07/30/a.jpeg">' +
      '<img src="https://shotcan.com/images/2026/08/02/b.jpg">' +
      '<img src="https://www.1337xx.to/images/logo.png">'; // chrome, rejected by allowlist
    expect(extract1337xImages(html)).toEqual([
      "https://imgtraffic.com/1s/2026/07/30/a.jpeg",
      "https://shotcan.com/images/2026/08/02/b.jpg",
    ]);
  });
});

describe("thumbFor", () => {
  it("derives a Chevereto medium variant when the host uses that scheme", () => {
    expect(thumbFor("https://trafficimage.club/images/2026/08/11/abc.jpg")).toBe(
      "https://trafficimage.club/images/2026/08/11/abc.md.jpg",
    );
  });
  it("leaves other hosts unchanged", () => {
    expect(thumbFor("https://imgtraffic.com/1s/2026/07/30/a.jpeg")).toBe(
      "https://imgtraffic.com/1s/2026/07/30/a.jpeg",
    );
  });
});
