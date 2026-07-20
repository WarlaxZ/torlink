import { describe, it, expect } from "vitest";
import { parseRepoSlug } from "./github";
import { fetchLatestRelease } from "./github";

describe("parseRepoSlug", () => {
  it("parses git+https with a .git suffix", () => {
    expect(parseRepoSlug("git+https://github.com/WarlaxZ/torlink.git")).toEqual({
      owner: "WarlaxZ",
      repo: "torlink",
    });
  });
  it("parses a plain https url", () => {
    expect(parseRepoSlug("https://github.com/WarlaxZ/torlink")).toEqual({
      owner: "WarlaxZ",
      repo: "torlink",
    });
  });
  it("parses an ssh url", () => {
    expect(parseRepoSlug("git@github.com:WarlaxZ/torlink.git")).toEqual({
      owner: "WarlaxZ",
      repo: "torlink",
    });
  });
  it("returns null for a non-github url or garbage", () => {
    expect(parseRepoSlug("https://gitlab.com/o/r")).toBeNull();
    expect(parseRepoSlug("not a url")).toBeNull();
    expect(parseRepoSlug(null)).toBeNull();
  });
});

describe("fetchLatestRelease", () => {
  const body = {
    tag_name: "v1.5.1",
    assets: [
      { name: "torlnk-linux-x64.tar.gz", browser_download_url: "https://d/l.tar.gz" },
      { name: "SHA256SUMS", browser_download_url: "https://d/SHA256SUMS" },
    ],
  };
  const ok = async (): Promise<Response> =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  it("returns the version, assets, and the SHA256SUMS url", async () => {
    const rel = await fetchLatestRelease({ owner: "WarlaxZ", repo: "torlink", fetchImpl: ok });
    expect(rel).toEqual({
      version: "1.5.1",
      assets: [
        { name: "torlnk-linux-x64.tar.gz", url: "https://d/l.tar.gz" },
        { name: "SHA256SUMS", url: "https://d/SHA256SUMS" },
      ],
      sha256Url: "https://d/SHA256SUMS",
    });
  });
  it("calls the releases/latest endpoint for the slug", async () => {
    const urls: string[] = [];
    await fetchLatestRelease({
      owner: "WarlaxZ",
      repo: "torlink",
      fetchImpl: async (url) => {
        urls.push(url);
        return ok();
      },
    });
    expect(urls).toEqual(["https://api.github.com/repos/WarlaxZ/torlink/releases/latest"]);
  });
  it("returns null on a non-ok response", async () => {
    const rel = await fetchLatestRelease({
      owner: "o",
      repo: "r",
      fetchImpl: async () => ({ ok: false, status: 404 }) as unknown as Response,
    });
    expect(rel).toBeNull();
  });
  it("returns null when the fetch throws (offline/timeout)", async () => {
    const rel = await fetchLatestRelease({
      owner: "o",
      repo: "r",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(rel).toBeNull();
  });
  it("returns null when tag_name is missing", async () => {
    const rel = await fetchLatestRelease({
      owner: "o",
      repo: "r",
      fetchImpl: async () => ({ ok: true, json: async () => ({ assets: [] }) }) as unknown as Response,
    });
    expect(rel).toBeNull();
  });
});
