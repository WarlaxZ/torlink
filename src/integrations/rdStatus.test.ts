import { describe, it, expect } from "vitest";
import {
  rdStatusFromUser,
  daysUntil,
  premiumExpiringSoon,
  formatAccountStatus,
} from "./rdStatus";
import type { RealDebridUser } from "./realdebrid";

const NOW = new Date("2026-06-30T00:00:00.000Z");

function user(overrides: Partial<RealDebridUser> = {}): RealDebridUser {
  return { username: "ash", type: "premium", premium: 100 * 86_400, ...overrides };
}

describe("rdStatusFromUser", () => {
  it("marks an active premium account and derives expiry from premium seconds", () => {
    const s = rdStatusFromUser(user({ premium: 10 * 86_400, expiration: undefined }), NOW);
    expect(s.username).toBe("ash");
    expect(s.premium).toBe(true);
    expect(s.premiumUntil?.toISOString()).toBe("2026-07-10T00:00:00.000Z");
  });

  it("prefers a valid expiration string over the seconds estimate", () => {
    const s = rdStatusFromUser(user({ expiration: "2026-12-01T00:00:00.000Z" }), NOW);
    expect(s.premiumUntil?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("treats a free/expired account as not premium with no expiry", () => {
    const s = rdStatusFromUser(user({ type: "free", premium: 0 }), NOW);
    expect(s.premium).toBe(false);
    expect(s.premiumUntil).toBeNull();
  });

  it("falls back to the seconds estimate when expiration is unparseable", () => {
    const s = rdStatusFromUser(user({ premium: 10 * 86_400, expiration: "not-a-date" }), NOW);
    expect(s.premiumUntil?.toISOString()).toBe("2026-07-10T00:00:00.000Z");
  });
});

describe("daysUntil", () => {
  it("rounds up and never goes negative", () => {
    expect(daysUntil(new Date("2026-07-10T00:00:00.000Z"), NOW)).toBe(10);
    expect(daysUntil(new Date("2026-06-29T00:00:00.000Z"), NOW)).toBe(0);
  });

  it("rounds a partial day up to 1", () => {
    expect(daysUntil(new Date("2026-06-30T23:00:00.000Z"), NOW)).toBe(1);
  });
});

describe("premiumExpiringSoon", () => {
  it("is true within 14 days, false otherwise", () => {
    const soon = rdStatusFromUser(user({ premium: 5 * 86_400, expiration: undefined }), NOW);
    const later = rdStatusFromUser(user({ premium: 100 * 86_400, expiration: undefined }), NOW);
    expect(premiumExpiringSoon(soon, NOW)).toBe(true);
    expect(premiumExpiringSoon(later, NOW)).toBe(false);
  });
});

describe("formatAccountStatus", () => {
  it("describes connection state for the token prompt", () => {
    expect(formatAccountStatus(null, NOW)).toBe("not connected");
    const free = rdStatusFromUser(user({ type: "free", premium: 0 }), NOW);
    expect(formatAccountStatus(free, NOW)).toBe("free account");
    const prem = rdStatusFromUser(user({ premium: 10 * 86_400, expiration: undefined }), NOW);
    expect(formatAccountStatus(prem, NOW)).toBe("premium · 10d left");
  });
});
