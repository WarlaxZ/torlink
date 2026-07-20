import { describe, it, expect } from "vitest";
import { compareVersions, isNewer, fetchLatestVersion } from "./version";

describe("compareVersions", () => {
  it("orders by major, minor, then patch", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.4.1", "1.4.0")).toBeGreaterThan(0);
    expect(compareVersions("1.4.1", "1.4.1")).toBe(0);
  });
  it("tolerates a leading v and uneven lengths", () => {
    expect(compareVersions("v1.4", "1.4.0")).toBe(0);
    expect(compareVersions("1.4.1", "1.4")).toBeGreaterThan(0);
  });
  it("ignores pre-release and build suffixes", () => {
    expect(compareVersions("1.4.1-rc.2", "1.4.1")).toBe(0);
    expect(compareVersions("1.5.0+build9", "1.4.9")).toBeGreaterThan(0);
  });
});

describe("isNewer", () => {
  it("is true only when the candidate is ahead of current", () => {
    expect(isNewer("1.4.0", "1.4.1")).toBe(true);
    expect(isNewer("1.4.1", "1.4.1")).toBe(false);
    expect(isNewer("1.4.1", "1.4.0")).toBe(false);
  });
});

describe("fetchLatestVersion", () => {
  const release = (tag: string): Response =>
    ({ ok: true, json: async () => ({ tag_name: tag, assets: [] }) }) as unknown as Response;

  it("returns the version from the repo's latest GitHub release", async () => {
    const v = await fetchLatestVersion({
      repoUrl: "https://github.com/WarlaxZ/torlink",
      fetchImpl: async () => release("v1.5.1"),
    });
    expect(v).toBe("1.5.1");
  });
  it("builds the API url from the repository slug", async () => {
    const urls: string[] = [];
    await fetchLatestVersion({
      repoUrl: "git+https://github.com/WarlaxZ/torlink.git",
      fetchImpl: async (url) => {
        urls.push(url);
        return release("v2.0.0");
      },
    });
    expect(urls).toEqual(["https://api.github.com/repos/WarlaxZ/torlink/releases/latest"]);
  });
  it("returns null when the repo url is not a GitHub url", async () => {
    const v = await fetchLatestVersion({
      repoUrl: "https://gitlab.com/o/r",
      fetchImpl: async () => release("v9.9.9"),
    });
    expect(v).toBeNull();
  });
  it("returns null on a non-ok response", async () => {
    const v = await fetchLatestVersion({
      repoUrl: "https://github.com/o/r",
      fetchImpl: async () => ({ ok: false, status: 404 }) as unknown as Response,
    });
    expect(v).toBeNull();
  });
});
