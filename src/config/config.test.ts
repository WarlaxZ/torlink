import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  loadConfig,
  saveConfig,
  resolveRealDebridToken,
  resolveMediaPlayer,
  resolveDnsServers,
  resolveReccConfig,
  resolveAdultContent,
  defaultConfig,
  resolveActiveDebrid,
  resolveDebridTokenFor,
  resolveTorBoxToken,
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

describe("resolveAdultContent", () => {
  const KEY = "TORLINK_ADULT";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("defaults to OFF and honours the persisted flag", () => {
    delete process.env[KEY];
    expect(resolveAdultContent({ downloadDir: "/d", trackers: [] })).toBe(false);
    expect(resolveAdultContent({ downloadDir: "/d", trackers: [], adultContent: false })).toBe(false);
    expect(resolveAdultContent({ downloadDir: "/d", trackers: [], adultContent: true })).toBe(true);
  });

  it("lets the env var override the config in both directions", () => {
    // Env forces ON even when config is off/unset.
    for (const truthy of ["1", "true", "YES", "on"]) {
      process.env[KEY] = truthy;
      expect(resolveAdultContent({ downloadDir: "/d", trackers: [] })).toBe(true);
    }
    // Env forces OFF even when config is on.
    for (const falsy of ["0", "false", "no", ""]) {
      process.env[KEY] = falsy;
      expect(resolveAdultContent({ downloadDir: "/d", trackers: [], adultContent: true })).toBe(false);
    }
  });

  it("round-trips adultContent across a save/load cycle", async () => {
    await saveConfig({ downloadDir: "/tmp/dl", trackers: [], adultContent: true });
    const cfg = await loadConfig();
    expect(cfg.adultContent).toBe(true);
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

describe("resolveReccConfig", () => {
  const base = { downloadDir: "/tmp/dl", trackers: [] as string[] };

  it("uses config values when no env override is set", () => {
    delete process.env.TORLINK_RECC_URL;
    delete process.env.TORLINK_RECC_TOKEN;
    expect(resolveReccConfig({ ...base, reccUrl: "http://host:4100", reccToken: "tok" })).toEqual({
      reccUrl: "http://host:4100",
      reccToken: "tok",
    });
  });

  it("prefers env vars over config values", () => {
    process.env.TORLINK_RECC_URL = "http://env:4100";
    process.env.TORLINK_RECC_TOKEN = "envtok";
    try {
      expect(resolveReccConfig({ ...base, reccUrl: "http://host:4100", reccToken: "tok" })).toEqual({
        reccUrl: "http://env:4100",
        reccToken: "envtok",
      });
    } finally {
      delete process.env.TORLINK_RECC_URL;
      delete process.env.TORLINK_RECC_TOKEN;
    }
  });

  it("returns undefined fields when neither env nor config is set", () => {
    delete process.env.TORLINK_RECC_URL;
    delete process.env.TORLINK_RECC_TOKEN;
    expect(resolveReccConfig({ ...base })).toEqual({ reccUrl: undefined, reccToken: undefined });
  });
});

describe("resolveTorBoxToken", () => {
  const KEY = "TORBOX_API_TOKEN";
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY]; });
  afterEach(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

  it("reads the persisted token", () => {
    expect(resolveTorBoxToken({ ...defaultConfig, torBoxToken: "  tb-1  " })).toBe("tb-1");
  });

  it("lets the env var win, so the token need never touch disk", () => {
    process.env[KEY] = " tb-env ";
    expect(resolveTorBoxToken({ ...defaultConfig, torBoxToken: "tb-file" })).toBe("tb-env");
  });

  it("is empty when neither is set", () => {
    expect(resolveTorBoxToken(defaultConfig)).toBe("");
  });
});

describe("resolveActiveDebrid", () => {
  const KEYS = ["REALDEBRID_API_TOKEN", "TORBOX_API_TOKEN"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  });

  it("is null when no token is configured at all", () => {
    expect(resolveActiveDebrid(defaultConfig)).toBeNull();
  });

  it("uses the only configured provider, whichever it is", () => {
    expect(resolveActiveDebrid({ ...defaultConfig, realDebridToken: "rd-1" }))
      .toEqual({ provider: "realdebrid", token: "rd-1" });
    expect(resolveActiveDebrid({ ...defaultConfig, torBoxToken: "tb-1" }))
      .toEqual({ provider: "torbox", token: "tb-1" });
  });

  it("honours the explicit preference when both are configured", () => {
    const both = { ...defaultConfig, realDebridToken: "rd-1", torBoxToken: "tb-1" };
    expect(resolveActiveDebrid({ ...both, debridProvider: "torbox" }))
      .toEqual({ provider: "torbox", token: "tb-1" });
    expect(resolveActiveDebrid({ ...both, debridProvider: "realdebrid" }))
      .toEqual({ provider: "realdebrid", token: "rd-1" });
  });

  it("falls back to Real-Debrid when both are configured and nothing is preferred", () => {
    expect(resolveActiveDebrid({ ...defaultConfig, realDebridToken: "rd-1", torBoxToken: "tb-1" }))
      .toEqual({ provider: "realdebrid", token: "rd-1" });
  });

  it("ignores a preference whose token is missing rather than reporting nothing configured", () => {
    expect(resolveActiveDebrid({ ...defaultConfig, torBoxToken: "tb-1", debridProvider: "realdebrid" }))
      .toEqual({ provider: "torbox", token: "tb-1" });
  });

  it("ignores a hand-edited nonsense preference", () => {
    const cfg = { ...defaultConfig, realDebridToken: "rd-1", debridProvider: "nonsense" as never };
    expect(resolveActiveDebrid(cfg)).toEqual({ provider: "realdebrid", token: "rd-1" });
  });

  it("counts an env-only token, so a preference works with nothing on disk", () => {
    process.env["TORBOX_API_TOKEN"] = "tb-env";
    expect(resolveActiveDebrid({ ...defaultConfig, debridProvider: "torbox" }))
      .toEqual({ provider: "torbox", token: "tb-env" });
  });
});

describe("resolveDebridTokenFor", () => {
  it("reads the token for a named provider", () => {
    const cfg = { ...defaultConfig, realDebridToken: "rd-1", torBoxToken: "tb-1" };
    expect(resolveDebridTokenFor(cfg, "realdebrid")).toBe("rd-1");
    expect(resolveDebridTokenFor(cfg, "torbox")).toBe("tb-1");
  });
});
