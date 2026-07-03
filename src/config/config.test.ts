import { describe, it, expect, afterEach } from "vitest";
import {
  loadConfig,
  saveConfig,
  resolveRealDebridToken,
  resolveMediaPlayer,
  resolveDnsServers,
} from "./config";

describe("config realDebridToken", () => {
  it("round-trips the token through save and load", async () => {
    await saveConfig({ downloadDir: "/tmp/dl", realDebridToken: "abc123" });
    const cfg = await loadConfig();
    expect(cfg.realDebridToken).toBe("abc123");
  });
});

describe("config UI preferences", () => {
  it("round-trips the persisted sort and category", async () => {
    await saveConfig({ downloadDir: "/tmp/dl", sort: "seeders:desc", category: "movies" });
    const cfg = await loadConfig();
    expect(cfg.sort).toBe("seeders:desc");
    expect(cfg.category).toBe("movies");
  });
});

describe("resolveRealDebridToken", () => {
  const KEY = "REALDEBRID_API_TOKEN";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns the config token when no env var is set", () => {
    delete process.env[KEY];
    expect(resolveRealDebridToken({ downloadDir: "/d", realDebridToken: "from-config" })).toBe(
      "from-config",
    );
  });

  it("lets the env var override the config token", () => {
    process.env[KEY] = "from-env";
    expect(resolveRealDebridToken({ downloadDir: "/d", realDebridToken: "from-config" })).toBe(
      "from-env",
    );
  });

  it("trims whitespace and returns empty string when nothing is set", () => {
    delete process.env[KEY];
    expect(resolveRealDebridToken({ downloadDir: "/d" })).toBe("");
    expect(resolveRealDebridToken({ downloadDir: "/d", realDebridToken: "  spaced  " })).toBe(
      "spaced",
    );
  });
});

describe("resolveDnsServers", () => {
  const KEY = "TORLINK_DNS";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns the config servers (alias-expanded) when no env var is set", () => {
    delete process.env[KEY];
    expect(resolveDnsServers({ downloadDir: "/d" })).toEqual([]);
    expect(resolveDnsServers({ downloadDir: "/d", dnsServers: ["cloudflare"] })).toEqual([
      "1.1.1.1",
      "1.0.0.1",
    ]);
  });

  it("lets the env var override config", () => {
    process.env[KEY] = "9.9.9.9";
    expect(resolveDnsServers({ downloadDir: "/d", dnsServers: ["cloudflare"] })).toEqual([
      "9.9.9.9",
    ]);
  });

  it("treats an empty env var as 'use system resolver'", () => {
    process.env[KEY] = "";
    expect(resolveDnsServers({ downloadDir: "/d", dnsServers: ["cloudflare"] })).toEqual([]);
  });
});

describe("resolveMediaPlayer", () => {
  const KEY = "TORLINK_PLAYER";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns config value, env override, or empty", () => {
    delete process.env[KEY];
    expect(resolveMediaPlayer({ downloadDir: "/d" })).toBe("");
    expect(resolveMediaPlayer({ downloadDir: "/d", mediaPlayer: "mpv" })).toBe("mpv");
    process.env[KEY] = "iina";
    expect(resolveMediaPlayer({ downloadDir: "/d", mediaPlayer: "mpv" })).toBe("iina");
  });
});
