import { describe, it, expect } from "vitest";
import { classifyStreamRoute } from "./streamRoute";
import type { Config } from "../config/config";
import type { DebridStatus } from "../integrations/debrid/types";

const base: Config = { downloadDir: "/tmp/dl", trackers: [] };
const withToken: Config = { ...base, realDebridToken: "tok" };

describe("classifyStreamRoute", () => {
  it("no token -> torrent-auto", () => {
    expect(classifyStreamRoute(base, null)).toEqual({ kind: "torrent-auto" });
  });

  it("token + premium -> realdebrid", () => {
    const rd: DebridStatus = {
      provider: "realdebrid",
      username: "u",
      active: true,
      planLabel: "premium",
      expiresAt: null,
    };
    expect(classifyStreamRoute(withToken, rd)).toEqual({ kind: "realdebrid" });
  });

  it("token + status unknown -> realdebrid (let the attempt decide)", () => {
    expect(classifyStreamRoute(withToken, null)).toEqual({ kind: "realdebrid" });
  });

  it("token + non-premium -> torrent-confirm with a reason", () => {
    const rd: DebridStatus = {
      provider: "realdebrid",
      username: "u",
      active: false,
      planLabel: "free",
      expiresAt: null,
    };
    const r = classifyStreamRoute(withToken, rd);
    expect(r.kind).toBe("torrent-confirm");
    expect((r as { reason: string }).reason).toMatch(/premium/i);
  });
});
