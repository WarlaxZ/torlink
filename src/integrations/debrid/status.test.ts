import { describe, expect, it } from "vitest";
import { daysUntil, expiringSoon, formatAccountStatus } from "./status";
import type { DebridStatus } from "./types";
import { debridStatusFromRealDebridUser } from "./realdebrid";
import { getDebridProvider, DEBRID_PROVIDER_IDS } from "./index";

const NOW = new Date("2026-07-30T00:00:00Z");

function status(over: Partial<DebridStatus> = {}): DebridStatus {
  return {
    provider: "realdebrid",
    username: "ada",
    active: true,
    planLabel: "premium",
    expiresAt: null,
    ...over,
  };
}

describe("debrid status presentation", () => {
  it("reports not connected for a null status", () => {
    expect(formatAccountStatus(null, NOW)).toBe("not connected");
  });

  it("names the plan when the account cannot add torrents", () => {
    expect(formatAccountStatus(status({ active: false, planLabel: "free" }), NOW)).toBe("free account");
  });

  it("counts whole days remaining, rounded up", () => {
    const expiresAt = new Date("2026-08-13T12:00:00Z");
    expect(daysUntil(expiresAt, NOW)).toBe(15);
    expect(formatAccountStatus(status({ expiresAt }), NOW)).toBe("premium · 15d left");
  });

  it("floors days remaining at zero for a past date", () => {
    expect(daysUntil(new Date("2026-07-01T00:00:00Z"), NOW)).toBe(0);
  });

  it("warns at or below 14 days and not above", () => {
    expect(expiringSoon(status({ expiresAt: new Date("2026-08-13T00:00:00Z") }), NOW)).toBe(true);
    expect(expiringSoon(status({ expiresAt: new Date("2026-08-14T00:00:00Z") }), NOW)).toBe(false);
    expect(expiringSoon(status({ expiresAt: null }), NOW)).toBe(false);
  });

  it("falls back to the bare plan label when there is no expiry", () => {
    expect(formatAccountStatus(status(), NOW)).toBe("premium");
  });
});

describe("debridStatusFromRealDebridUser", () => {
  it("maps an active premium account, preferring the expiration date", () => {
    const s = debridStatusFromRealDebridUser(
      { username: "ada", type: "premium", premium: 86_400, expiration: "2026-08-20T00:00:00Z" },
      NOW,
    );
    expect(s).toEqual({
      provider: "realdebrid",
      username: "ada",
      active: true,
      planLabel: "premium",
      expiresAt: new Date("2026-08-20T00:00:00Z"),
    });
  });

  it("derives the expiry from remaining seconds when there is no date", () => {
    const s = debridStatusFromRealDebridUser({ username: "ada", type: "premium", premium: 86_400 }, NOW);
    expect(s.expiresAt).toEqual(new Date("2026-07-31T00:00:00Z"));
  });

  it("ignores an unparseable expiration and uses the seconds", () => {
    const s = debridStatusFromRealDebridUser(
      { username: "ada", type: "premium", premium: 86_400, expiration: "not a date" },
      NOW,
    );
    expect(s.expiresAt).toEqual(new Date("2026-07-31T00:00:00Z"));
  });

  it("marks a free account inactive with no expiry", () => {
    const s = debridStatusFromRealDebridUser({ username: "ada", type: "free", premium: 0 }, NOW);
    expect(s.active).toBe(false);
    expect(s.planLabel).toBe("free");
    expect(s.expiresAt).toBeNull();
  });
});

describe("the debrid provider registry", () => {
  it("returns the Real-Debrid provider with its UI metadata", () => {
    const p = getDebridProvider("realdebrid");
    expect(p.id).toBe("realdebrid");
    expect(p.label).toBe("Real-Debrid");
    expect(p.shortLabel).toBe("RD");
    expect(p.tokenEnvVar).toBe("REALDEBRID_API_TOKEN");
  });

  it("does not offer a cached check for Real-Debrid — the endpoint was removed in 2024", () => {
    expect(getDebridProvider("realdebrid").checkCached).toBeUndefined();
  });

  it("lists every provider id", () => {
    expect([...DEBRID_PROVIDER_IDS]).toEqual(["realdebrid", "torbox"]);
  });

  it("returns the TorBox provider, which can check cached availability", () => {
    const p = getDebridProvider("torbox");
    expect(p.label).toBe("TorBox");
    expect(p.shortLabel).toBe("TB");
    expect(p.tokenEnvVar).toBe("TORBOX_API_TOKEN");
    expect(p.checkCached).toBeDefined();
  });
});
