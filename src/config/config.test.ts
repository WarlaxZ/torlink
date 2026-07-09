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
    await saveConfig({ downloadDir: "/tmp/dl", realDebridToken: "abc123", trackers: [] });
    const cfg = await loadConfig();
    expect(cfg.realDebridToken).toBe("abc123");
  });
});

describe("config recc fields", () => {
  it("round-trips reccUrl and reccToken through save and load", async () => {
    await saveConfig({
      downloadDir: "/tmp/dl",
      reccUrl: "http://localhost:4100",
      reccToken: "recc-abc123",
      trackers: [],
    });
    const cfg = await loadConfig();
    expect(cfg.reccUrl).toBe("http://localhost:4100");
    expect(cfg.reccToken).toBe("recc-abc123");
  });
});

describe("config UI preferences", () => {
  it("round-trips the persisted sort and category", async () => {
    await saveConfig({
      downloadDir: "/tmp/dl",
      sort: "seeders:desc",
      category: "movies",
      trackers: [],
    });
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
    expect(resolveRealDebridToken({ downloadDir: "/d", realDebridToken: "from-config", trackers: [] })).toBe(
      "from-config",
    );
  });

  it("lets the env var override the config token", () => {
    process.env[KEY] = "from-env";
    expect(resolveRealDebridToken({ downloadDir: "/d", realDebridToken: "from-config", trackers: [] })).toBe(
      "from-env",
    );
  });

  it("trims whitespace and returns empty string when nothing is set", () => {
    delete process.env[KEY];
    expect(resolveRealDebridToken({ downloadDir: "/d", trackers: [] })).toBe("");
    expect(resolveRealDebridToken({ downloadDir: "/d", realDebridToken: "  spaced  ", trackers: [] })).toBe(
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
    expect(resolveDnsServers({ downloadDir: "/d", trackers: [] })).toEqual([]);
    expect(resolveDnsServers({ downloadDir: "/d", dnsServers: ["cloudflare"], trackers: [] })).toEqual([
      "1.1.1.1",
      "1.0.0.1",
    ]);
  });

  it("lets the env var override config", () => {
    process.env[KEY] = "9.9.9.9";
    expect(resolveDnsServers({ downloadDir: "/d", dnsServers: ["cloudflare"], trackers: [] })).toEqual([
      "9.9.9.9",
    ]);
  });

  it("treats an empty env var as 'use system resolver'", () => {
    process.env[KEY] = "";
    expect(resolveDnsServers({ downloadDir: "/d", dnsServers: ["cloudflare"], trackers: [] })).toEqual([]);
  });
});

describe("resolveMediaPlayer", () => {
  const KEY = "TORLINK_PLAYER";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns config value, env override, or empty", () => {
    delete process.env[KEY];
    expect(resolveMediaPlayer({ downloadDir: "/d", trackers: [] })).toBe("");
    expect(resolveMediaPlayer({ downloadDir: "/d", mediaPlayer: "mpv", trackers: [] })).toBe("mpv");
    process.env[KEY] = "iina";
    expect(resolveMediaPlayer({ downloadDir: "/d", mediaPlayer: "mpv", trackers: [] })).toBe("iina");
  });
});

describe("config torrentStreamAck", () => {
  it("round-trips torrentStreamAck across a save/load cycle", async () => {
    await saveConfig({
      downloadDir: "/tmp/dl",
      torrentStreamAck: true,
      trackers: [],
    });
    const cfg = await loadConfig();
    expect(cfg.torrentStreamAck).toBe(true);
  });
});

describe("config vpnInterface", () => {
  it("round-trips the VPN kill-switch interface", async () => {
    await saveConfig({ downloadDir: "/tmp/dl", trackers: [], vpnInterface: "tun0" });
    expect((await loadConfig()).vpnInterface).toBe("tun0");
  });
});

describe("config favourites", () => {
  it("round-trips favourites with watched episodes", async () => {
    await saveConfig({
      downloadDir: "/tmp/dl",
      trackers: [],
      favourites: [
        { id: "hash1", name: "Series", magnet: "magnet:?xt=1", addedAt: 5, watched: ["ep1"] },
      ],
    });
    const cfg = await loadConfig();
    expect(cfg.favourites).toEqual([
      { id: "hash1", name: "Series", magnet: "magnet:?xt=1", addedAt: 5, watched: ["ep1"] },
    ]);
  });

  it("drops junk favourites and non-string watched entries", async () => {
    await saveConfig({
      downloadDir: "/tmp/dl",
      trackers: [],
      favourites: [
        { id: "", name: "no id", magnet: "m", addedAt: 1 },
        { id: "ok", name: "", magnet: "m", addedAt: 1 },
        { id: "keep", name: "Keep", magnet: "m", addedAt: 2, watched: ["ep1", 3, null] },
      ] as any,
    });
    const cfg = await loadConfig();
    expect(cfg.favourites).toEqual([
      { id: "keep", name: "Keep", magnet: "m", addedAt: 2, watched: ["ep1"] },
    ]);
  });

  it("defaults addedAt to 0 and caps at 100 entries", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: `h${i}`,
      name: `n${i}`,
      magnet: "m",
    }));
    await saveConfig({ downloadDir: "/tmp/dl", trackers: [], favourites: many as any });
    const cfg = await loadConfig();
    expect(cfg.favourites?.length).toBe(100);
    expect(cfg.favourites?.[0]?.addedAt).toBe(0);
  });

  it("defaults to [] when favourites is missing", async () => {
    await saveConfig({ downloadDir: "/tmp/dl", trackers: [] });
    expect((await loadConfig()).favourites).toEqual([]);
  });
});
