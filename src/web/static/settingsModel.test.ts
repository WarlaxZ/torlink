import { describe, it, expect } from "vitest";
import {
  accountRows,
  numberPatch,
  settingsSections,
  sourceTogglePatch,
  textPatch,
  togglePatch,
} from "./settingsModel";
import type { SettingsAccounts, SettingsResponse } from "../wire";

function response(over: Partial<SettingsResponse["settings"]> = {}, envOver: Partial<SettingsResponse["envLocks"]> = {}): SettingsResponse {
  return {
    settings: {
      downloadDir: "/downloads",
      mediaPlayer: "",
      adultContent: false,
      proxyDebridStreams: false,
      downloadLimitKbps: null,
      uploadLimitKbps: null,
      seedRatio: null,
      seedMinutes: null,
      disabledSources: [],
      preferences: { maxResolution: null, require: [], exclude: [] },
      ...over,
    },
    envLocks: { adultContent: false, mediaPlayer: false, ...envOver },
    accounts: {
      debridConfigured: false,
      cloudflareAccessEnforced: false,
      debridProvider: null,
      omdbConfigured: false,
      reccConfigured: false,
      reccAccount: null,
    },
    refused: [],
  };
}

function controlFor(res: SettingsResponse, key: string) {
  return settingsSections(res)
    .flatMap((s) => s.controls)
    .find((c) => c.key === key);
}

describe("settingsSections", () => {
  it("reflects the stored values in each control", () => {
    const res = response({
      adultContent: true,
      proxyDebridStreams: true,
      downloadDir: "/media/dl",
      mediaPlayer: "mpv",
      downloadLimitKbps: 1500,
      seedRatio: 1.5,
    });
    expect(controlFor(res, "adultContent")).toMatchObject({ kind: "toggle", value: true, locked: false });
    expect(controlFor(res, "proxyDebridStreams")).toMatchObject({ kind: "toggle", value: true });
    expect(controlFor(res, "downloadDir")).toMatchObject({ kind: "text", value: "/media/dl" });
    expect(controlFor(res, "mediaPlayer")).toMatchObject({ kind: "text", value: "mpv" });
    expect(controlFor(res, "downloadLimitKbps")).toMatchObject({ kind: "number", value: 1500 });
    expect(controlFor(res, "seedRatio")).toMatchObject({ kind: "number", value: 1.5 });
  });

  it("marks env-locked controls locked with a note explaining the env var", () => {
    const res = response({}, { adultContent: true, mediaPlayer: true });
    const adult = controlFor(res, "adultContent");
    const player = controlFor(res, "mediaPlayer");
    expect(adult).toMatchObject({ locked: true });
    expect(adult?.lockNote).toContain("TORLINK_ADULT");
    expect(player).toMatchObject({ locked: true });
    expect(player?.lockNote).toContain("TORLINK_PLAYER");
  });

  it("leaves unlocked controls with a null lockNote", () => {
    const res = response();
    expect(controlFor(res, "adultContent")?.lockNote).toBeNull();
    expect(controlFor(res, "downloadDir")?.lockNote).toBeNull();
  });
});

describe("togglePatch", () => {
  it("flips the current value", () => {
    expect(togglePatch("adultContent", false)).toEqual({ adultContent: true });
    expect(togglePatch("proxyDebridStreams", true)).toEqual({ proxyDebridStreams: false });
  });
});

describe("numberPatch", () => {
  it("sends a positive number as typed", () => {
    expect(numberPatch("downloadLimitKbps", "1500")).toEqual({ downloadLimitKbps: 1500 });
    expect(numberPatch("seedRatio", "1.5")).toEqual({ seedRatio: 1.5 });
  });

  it("clears to null for a blank box or a non-positive / junk value", () => {
    expect(numberPatch("downloadLimitKbps", "")).toEqual({ downloadLimitKbps: null });
    expect(numberPatch("downloadLimitKbps", "  ")).toEqual({ downloadLimitKbps: null });
    expect(numberPatch("uploadLimitKbps", "0")).toEqual({ uploadLimitKbps: null });
    expect(numberPatch("seedMinutes", "-4")).toEqual({ seedMinutes: null });
    expect(numberPatch("seedRatio", "fast")).toEqual({ seedRatio: null });
  });
});

describe("textPatch", () => {
  it("trims the value", () => {
    expect(textPatch("downloadDir", "  /media/dl  ")).toEqual({ downloadDir: "/media/dl" });
    expect(textPatch("mediaPlayer", "")).toEqual({ mediaPlayer: "" });
  });
});

describe("sourceTogglePatch", () => {
  it("removes an id from disabledSources when enabling it", () => {
    expect(sourceTogglePatch(["yts", "eztv"], "yts", true)).toEqual({ disabledSources: ["eztv"] });
  });

  it("adds an id to disabledSources when disabling it, without mutating the input", () => {
    const disabled = ["yts"];
    expect(sourceTogglePatch(disabled, "eztv", false)).toEqual({ disabledSources: ["yts", "eztv"] });
    expect(disabled).toEqual(["yts"]);
  });

  it("does not duplicate an already-disabled id", () => {
    expect(sourceTogglePatch(["yts"], "yts", false)).toEqual({ disabledSources: ["yts"] });
  });
});

describe("accountRows", () => {
  it("names the active debrid provider and reports its status", () => {
    const accounts: SettingsAccounts = {
      debridConfigured: true,
      cloudflareAccessEnforced: true,
      debridProvider: "torbox",
      omdbConfigured: true,
      reccConfigured: false,
      reccAccount: null,
    };
    const rows = accountRows(accounts);
    expect(rows[0]).toEqual({ label: "TorBox", status: "Connected", ok: true });
    expect(rows.find((r) => r.label === "OMDb")).toEqual({ label: "OMDb", status: "Key set", ok: true });
    expect(rows.find((r) => r.label === "reccd")).toMatchObject({ ok: false, status: "Not configured" });
  });

  it("falls back to a generic debrid label when none is active", () => {
    const rows = accountRows({
      debridConfigured: false,
      cloudflareAccessEnforced: false,
      debridProvider: null,
      omdbConfigured: false,
      reccConfigured: true,
      reccAccount: { name: "quiet-heron-4f2a", claimed: false },
    });
    expect(rows[0]).toEqual({ label: "Debrid", status: "Not connected", ok: false });
    expect(rows.find((r) => r.label === "reccd")).toMatchObject({ ok: true, status: "Signed in as quiet-heron-4f2a" });
  });

  it("reports Cloudflare Access as enforced or not configured, read-only", () => {
    const base: SettingsAccounts = {
      debridConfigured: false,
      cloudflareAccessEnforced: true,
      debridProvider: null,
      omdbConfigured: false,
      reccConfigured: false,
      reccAccount: null,
    };
    const enforced = accountRows(base).find((r) => r.label === "Cloudflare Access");
    expect(enforced).toEqual({ label: "Cloudflare Access", status: "Enforced", ok: true });
    const off = accountRows({ ...base, cloudflareAccessEnforced: false }).find((r) => r.label === "Cloudflare Access");
    expect(off).toEqual({ label: "Cloudflare Access", status: "Not configured", ok: false });
  });
});
