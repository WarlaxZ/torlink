import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  loadConfig,
  saveConfig,
  resolveRealDebridToken,
  resolveMediaPlayer,
  resolveDnsServers,
  resolveReccConfig,
  resolveAdultContent,
  resolveAdultScreenshots,
  defaultConfig,
  resolveActiveDebrid,
  resolveDebridTokenFor,
  resolveTorBoxToken,
  resolveCastAdvertiseHost,
  resolveCastDevice,
  qualityPrefsFrom,
  sanitiseQualityPrefs,
  sanitiseSettingsPatch,
  resolveOwnerEmail,
  profileFavourites,
  withProfileFavourites,
  profileSavedSearches,
  withProfileSavedSearches,
  withProfileReccAccount,
} from "./config";
import type { Config, FavouriteItem } from "./config";
import { OWNER_PROFILE, slugForEmail } from "../core/profile";

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

  it("round-trips the account name, claim state and opt-out", async () => {
    await saveConfig({
      downloadDir: "/tmp/dl",
      reccUrl: "https://reccd.stream",
      reccToken: "recc-abc123",
      reccAccountName: "quiet-heron-4f2a",
      reccAccountClaimed: false,
      reccAutoSignup: false,
      trackers: [],
    });
    const cfg = await loadConfig();
    expect(cfg.reccAccountName).toBe("quiet-heron-4f2a");
    expect(cfg.reccAccountClaimed).toBe(false);
    expect(cfg.reccAutoSignup).toBe(false);
  });

  // Absent has to mean "auto-provision", because a fresh install has no
  // config.json at all -- so the default must not be a stored `true`.
  it("leaves reccAutoSignup undefined when nothing set it", async () => {
    await saveConfig({ downloadDir: "/tmp/dl", trackers: [] });
    const cfg = await loadConfig();
    expect(cfg.reccAutoSignup).toBeUndefined();
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

describe("resolveAdultScreenshots", () => {
  it("defaults to ON when absent and honours an explicit false", () => {
    expect(resolveAdultScreenshots({ downloadDir: "/d", trackers: [] })).toBe(true);
    expect(resolveAdultScreenshots({ downloadDir: "/d", trackers: [], adultScreenshots: true })).toBe(true);
    expect(resolveAdultScreenshots({ downloadDir: "/d", trackers: [], adultScreenshots: false })).toBe(false);
  });
});

describe("sanitiseSettingsPatch — adultScreenshots", () => {
  it("coerces to a strict boolean", () => {
    expect(sanitiseSettingsPatch({ adultScreenshots: false })).toEqual({ adultScreenshots: false });
    expect(sanitiseSettingsPatch({ adultScreenshots: true })).toEqual({ adultScreenshots: true });
    expect(sanitiseSettingsPatch({ adultScreenshots: "yes" })).toEqual({ adultScreenshots: false });
  });
});

describe("config vpnInterface", () => {
  it("round-trips the VPN kill-switch interface", async () => {
    await saveConfig({ downloadDir: "/tmp/dl", trackers: [], vpnInterface: "tun0" });
    expect((await loadConfig()).vpnInterface).toBe("tun0");
  });
});

describe("config castDevice", () => {
  it("round-trips a configured Chromecast address", async () => {
    await saveConfig({ downloadDir: "/tmp/dl", trackers: [], castDevice: "192.168.0.40:8009" });
    expect((await loadConfig()).castDevice).toBe("192.168.0.40:8009");
  });

  it("stays absent when nothing was set, so the device list is discovery-only", async () => {
    await saveConfig({ downloadDir: "/tmp/dl", trackers: [] });
    expect((await loadConfig()).castDevice).toBeUndefined();
  });
});

describe("config castAdvertiseHost", () => {
  it("round-trips the host a TV should fetch from", async () => {
    await saveConfig({
      downloadDir: "/tmp/dl",
      trackers: [],
      castAdvertiseHost: "192.168.0.10:8080",
    });
    expect((await loadConfig()).castAdvertiseHost).toBe("192.168.0.10:8080");
  });

  it("stays absent when nothing was set, so castOrigin keeps guessing", async () => {
    await saveConfig({ downloadDir: "/tmp/dl", trackers: [] });
    expect((await loadConfig()).castAdvertiseHost).toBeUndefined();
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

describe("sanitiseQualityPrefs", () => {
  it("keeps a valid preference", () => {
    const out = sanitiseQualityPrefs({
      maxResolution: "1080p", requireFeatures: ["atmos"], excludeFeatures: ["dv"],
    });
    expect(out).toEqual({ maxResolution: "1080p", requireFeatures: ["atmos"], excludeFeatures: ["dv"] });
  });

  it("drops an invalid resolution", () => {
    expect(sanitiseQualityPrefs({ maxResolution: "8k" }).maxResolution).toBeUndefined();
  });

  it("drops unknown feature ids and non-strings", () => {
    const out = sanitiseQualityPrefs({ requireFeatures: ["atmos", "laserdisc", 7] as unknown as string[] });
    expect(out.requireFeatures).toEqual(["atmos"]);
  });

  it("collapses duplicates", () => {
    expect(sanitiseQualityPrefs({ requireFeatures: ["hdr", "hdr"] }).requireFeatures).toEqual(["hdr"]);
  });

  it("resolves a require/exclude collision in favour of exclude", () => {
    const out = sanitiseQualityPrefs({ requireFeatures: ["dv", "hdr"], excludeFeatures: ["dv"] });
    expect(out.excludeFeatures).toEqual(["dv"]);
    expect(out.requireFeatures).toEqual(["hdr"]);
  });
});

describe("sanitiseSettingsPatch", () => {
  it("returns an empty patch when nothing is provided, so absent keys are left untouched", () => {
    expect(sanitiseSettingsPatch({})).toEqual({});
  });

  it("only ever emits the non-secret, web-writable fields — never a token", () => {
    // A hand-crafted or malicious body that smuggles a token must not survive.
    const out = sanitiseSettingsPatch({
      realDebridToken: "sneaky",
      omdbApiKey: "sneaky",
      reccToken: "sneaky",
      adultContent: true,
    } as never);
    expect(out).toEqual({ adultContent: true });
    expect("realDebridToken" in out).toBe(false);
    expect("omdbApiKey" in out).toBe(false);
    expect("reccToken" in out).toBe(false);
  });

  it("coerces the toggles to strict booleans", () => {
    expect(sanitiseSettingsPatch({ adultContent: true, proxyDebridStreams: false }))
      .toEqual({ adultContent: true, proxyDebridStreams: false });
    // Anything that isn't literally true reads as false.
    expect(sanitiseSettingsPatch({ adultContent: "yes" as never })).toEqual({ adultContent: false });
  });

  it("floors positive transfer limits and clears non-positive or invalid ones", () => {
    expect(sanitiseSettingsPatch({ downloadLimitKbps: 1500.7, uploadLimitKbps: 200 }))
      .toEqual({ downloadLimitKbps: 1500, uploadLimitKbps: 200 });
    // 0 / negative / NaN mean "no limit" — the field is cleared.
    expect(sanitiseSettingsPatch({ downloadLimitKbps: 0, uploadLimitKbps: -5 }))
      .toEqual({ downloadLimitKbps: undefined, uploadLimitKbps: undefined });
    expect(sanitiseSettingsPatch({ downloadLimitKbps: "fast" as never }))
      .toEqual({ downloadLimitKbps: undefined });
  });

  it("keeps a fractional seed ratio but floors seed minutes", () => {
    expect(sanitiseSettingsPatch({ seedRatio: 1.5, seedMinutes: 90.9 }))
      .toEqual({ seedRatio: 1.5, seedMinutes: 90 });
    expect(sanitiseSettingsPatch({ seedRatio: 0, seedMinutes: -1 }))
      .toEqual({ seedRatio: undefined, seedMinutes: undefined });
  });

  it("dedupes disabledSources and drops non-string / empty entries", () => {
    expect(sanitiseSettingsPatch({ disabledSources: ["yts", "yts", "", 7, "tpb-tv"] as never }))
      .toEqual({ disabledSources: ["yts", "tpb-tv"] });
    expect(sanitiseSettingsPatch({ disabledSources: "not-an-array" as never }))
      .toEqual({ disabledSources: [] });
  });

  it("trims downloadDir and ignores it when blank, but lets mediaPlayer clear to empty", () => {
    expect(sanitiseSettingsPatch({ downloadDir: "  /media/dl  " })).toEqual({ downloadDir: "/media/dl" });
    // downloadDir is required, so a blank value must not blank the stored one.
    expect(sanitiseSettingsPatch({ downloadDir: "   " })).toEqual({});
    // mediaPlayer empty is meaningful: "clear it, fall back to auto-detect".
    expect(sanitiseSettingsPatch({ mediaPlayer: "  mpv " })).toEqual({ mediaPlayer: "mpv" });
    expect(sanitiseSettingsPatch({ mediaPlayer: "" })).toEqual({ mediaPlayer: "" });
  });

  it("folds in sanitiseQualityPrefs when any quality field is present", () => {
    expect(
      sanitiseSettingsPatch({
        maxResolution: "1080p",
        requireFeatures: ["atmos", "laserdisc"] as never,
        excludeFeatures: ["dv"],
      }),
    ).toEqual({ maxResolution: "1080p", requireFeatures: ["atmos"], excludeFeatures: ["dv"] });
    // A quality field present but empty still normalises the trio.
    expect(sanitiseSettingsPatch({ requireFeatures: [] }))
      .toEqual({ maxResolution: undefined, requireFeatures: [], excludeFeatures: [] });
  });
});

describe("qualityPrefsFrom", () => {
  it("returns empty lists when nothing is configured", () => {
    expect(qualityPrefsFrom({} as Config)).toEqual({ require: [], exclude: [] });
  });

  it("carries the configured preference through", () => {
    expect(qualityPrefsFrom({ maxResolution: "720p", requireFeatures: ["dd"] } as Config))
      .toEqual({ maxResolution: "720p", require: ["dd"], exclude: [] });
  });
});

describe("cast resolvers", () => {
  // Env wins over config, matching every other resolve* helper. It matters more
  // for these two than most: the setups that need them (WSL, a bridged container)
  // are deployed into rather than configured on, and have no TUI to open.
  afterEach(() => {
    delete process.env.TORLINK_CAST_HOST;
    delete process.env.TORLINK_CAST_DEVICE;
  });

  it("prefers the env var over the config file", () => {
    process.env.TORLINK_CAST_HOST = "192.168.0.10:8080";
    process.env.TORLINK_CAST_DEVICE = "192.168.0.40";
    const cfg = { downloadDir: "/tmp", trackers: [], castAdvertiseHost: "wrong", castDevice: "wrong" };
    expect(resolveCastAdvertiseHost(cfg)).toBe("192.168.0.10:8080");
    expect(resolveCastDevice(cfg)).toBe("192.168.0.40");
  });

  it("falls back to the config file, trimmed", () => {
    const cfg = {
      downloadDir: "/tmp",
      trackers: [],
      castAdvertiseHost: "  192.168.0.10  ",
      castDevice: "  192.168.0.40  ",
    };
    expect(resolveCastAdvertiseHost(cfg)).toBe("192.168.0.10");
    expect(resolveCastDevice(cfg)).toBe("192.168.0.40");
  });

  it("is undefined when neither is set, and when both are blank", () => {
    expect(resolveCastAdvertiseHost({ downloadDir: "/tmp", trackers: [] })).toBeUndefined();
    expect(resolveCastDevice({ downloadDir: "/tmp", trackers: [] })).toBeUndefined();
    process.env.TORLINK_CAST_HOST = "   ";
    expect(
      resolveCastAdvertiseHost({ downloadDir: "/tmp", trackers: [], castAdvertiseHost: "  " }),
    ).toBeUndefined();
  });
});

describe("per-profile config helpers", () => {
  const base: Config = { downloadDir: "/dl", trackers: [] };
  const FRIEND = slugForEmail("friend@example.com");
  const fav = (name: string): FavouriteItem => ({ id: name, name, magnet: `magnet:${name}`, addedAt: 1 });

  describe("resolveOwnerEmail", () => {
    afterEach(() => { delete process.env.TORLINK_OWNER_EMAIL; });
    it("prefers the env var, trimmed and lower-cased", () => {
      process.env.TORLINK_OWNER_EMAIL = "  Owner@Example.com ";
      expect(resolveOwnerEmail({ ...base, ownerEmail: "other@example.com" })).toBe("owner@example.com");
    });
    it("falls back to config, and undefined when unset", () => {
      expect(resolveOwnerEmail({ ...base, ownerEmail: "Owner@Example.com" })).toBe("owner@example.com");
      expect(resolveOwnerEmail(base)).toBeUndefined();
    });
  });

  describe("list accessors", () => {
    it("owner reads and writes the top-level fields", () => {
      const cfg = withProfileFavourites(base, OWNER_PROFILE, [fav("Kestrel")]);
      expect(cfg.favourites).toHaveLength(1);
      expect(profileFavourites(cfg, OWNER_PROFILE)).toHaveLength(1);
      expect(profileFavourites(cfg, FRIEND)).toEqual([]);
    });
    it("a friend reads and writes profiles[id], leaving the owner untouched", () => {
      const cfg = withProfileSavedSearches(base, FRIEND, ["harrowgate"]);
      expect(profileSavedSearches(cfg, FRIEND)).toEqual(["harrowgate"]);
      expect(cfg.savedSearches ?? []).toEqual([]);
      expect(profileSavedSearches(cfg, OWNER_PROFILE)).toEqual([]);
    });
    it("two friends do not see each other's favourites", () => {
      const other = slugForEmail("other@example.com");
      let cfg = withProfileFavourites(base, FRIEND, [fav("Ashfall")]);
      cfg = withProfileFavourites(cfg, other, [fav("Kepler")]);
      expect(profileFavourites(cfg, FRIEND).map((f) => f.name)).toEqual(["Ashfall"]);
      expect(profileFavourites(cfg, other).map((f) => f.name)).toEqual(["Kepler"]);
    });
  });

  describe("resolveReccConfig per profile", () => {
    it("owner uses the top-level token; a friend uses its own", () => {
      const cfg = withProfileReccAccount(
        { ...base, reccUrl: "https://reccd.stream", reccToken: "owner-tok" },
        FRIEND,
        { reccToken: "friend-tok", reccAccountName: "anon", reccAccountClaimed: false },
      );
      expect(resolveReccConfig(cfg).reccToken).toBe("owner-tok");
      expect(resolveReccConfig(cfg, OWNER_PROFILE).reccToken).toBe("owner-tok");
      expect(resolveReccConfig(cfg, FRIEND).reccToken).toBe("friend-tok");
      expect(resolveReccConfig(cfg, FRIEND).reccUrl).toBe("https://reccd.stream");
    });
    it("with no profile is identical to the owner profile", () => {
      const cfg: Config = { ...base, reccToken: "owner-tok" };
      expect(resolveReccConfig(cfg)).toEqual(resolveReccConfig(cfg, OWNER_PROFILE));
    });
  });

  describe("loadConfig validation", () => {
    it("drops junk profiles and keeps valid ones", async () => {
      await saveConfig({
        ...base,
        profiles: {
          [FRIEND]: {
            savedSearches: ["kepler", 3 as unknown as string, ""],
            favourites: [{ nope: true } as unknown as FavouriteItem],
          },
          bad: 7 as unknown as never,
        },
      });
      const cfg = await loadConfig();
      expect(cfg.profiles?.[FRIEND]?.savedSearches).toEqual(["kepler"]);
      expect(cfg.profiles?.[FRIEND]?.favourites).toEqual([]);
      expect(cfg.profiles?.bad).toBeUndefined();
    });
  });
});
