import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyStreamRoute } from "./streamRoute";
import { defaultConfig } from "../config/config";
import type { DebridStatus } from "../integrations/debrid/types";

function status(over: Partial<DebridStatus> = {}): DebridStatus {
  return { provider: "realdebrid", username: "ada", active: true, planLabel: "premium", expiresAt: null, ...over };
}

describe("classifyStreamRoute", () => {
  const KEYS = ["REALDEBRID_API_TOKEN", "TORBOX_API_TOKEN"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  });

  it("auto-routes to a torrent when no debrid is configured", () => {
    expect(classifyStreamRoute(defaultConfig, null)).toEqual({ kind: "torrent-auto" });
  });

  it("routes to the active provider", () => {
    expect(classifyStreamRoute({ ...defaultConfig, realDebridToken: "rd-1" }, status()))
      .toEqual({ kind: "debrid", provider: "realdebrid" });
    expect(classifyStreamRoute({ ...defaultConfig, torBoxToken: "tb-1" }, status({ provider: "torbox" })))
      .toEqual({ kind: "debrid", provider: "torbox" });
  });

  it("routes to the provider even when the status is unknown", () => {
    expect(classifyStreamRoute({ ...defaultConfig, torBoxToken: "tb-1" }, null))
      .toEqual({ kind: "debrid", provider: "torbox" });
  });

  it("demands a confirm, naming the provider, when the account cannot add torrents", () => {
    expect(classifyStreamRoute({ ...defaultConfig, realDebridToken: "rd-1" }, status({ active: false })))
      .toEqual({ kind: "torrent-confirm", reason: "your Real-Debrid plan isn't active" });
    expect(
      classifyStreamRoute(
        { ...defaultConfig, torBoxToken: "tb-1" },
        status({ provider: "torbox", active: false, planLabel: "free" }),
      ),
    ).toEqual({ kind: "torrent-confirm", reason: "your TorBox plan isn't active" });
  });

  it("ignores a status belonging to a provider that is not the active one", () => {
    // A stale status left over from a provider switch must not refuse a stream.
    expect(classifyStreamRoute({ ...defaultConfig, torBoxToken: "tb-1" }, status({ active: false })))
      .toEqual({ kind: "debrid", provider: "torbox" });
  });

  it("routes correctly even when debridProvider is a garbage/hand-edited value", () => {
    // resolveActiveDebrid's `preferred === "realdebrid" || preferred === "torbox"`
    // guard is the only thing standing between a hand-edited config.json and the
    // provider registry (which no longer throws on an unknown id). If that guard
    // were ever "simplified" to a cast, this test should catch it.
    expect(
      classifyStreamRoute({ ...defaultConfig, realDebridToken: "rd-1", debridProvider: "nonsense" as never }, status()),
    ).toEqual({ kind: "debrid", provider: "realdebrid" });
    expect(
      classifyStreamRoute({ ...defaultConfig, realDebridToken: "rd-1", debridProvider: "" as never }, status()),
    ).toEqual({ kind: "debrid", provider: "realdebrid" });
    expect(
      classifyStreamRoute({ ...defaultConfig, realDebridToken: "rd-1", debridProvider: "TorBox" as never }, status()),
    ).toEqual({ kind: "debrid", provider: "realdebrid" });
  });
});
