import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteTorrentMeta,
  exportTorrentMeta,
  saveTorrentMeta,
  torrentExportName,
} from "./persist";
import { normalizeVia } from "./types";

describe("torrent metadata export", () => {
  it("builds a safe .torrent filename from a torrent name", () => {
    expect(torrentExportName('Bad:/Name?* "Final". ', "abc123")).toBe(
      "Bad Name Final.torrent",
    );
    expect(torrentExportName("   ", "abc123")).toBe("abc123.torrent");
  });

  it("copies cached .torrent metadata into the requested folder", async () => {
    const id = `export-${Date.now()}`;
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-export-"));
    const data = new Uint8Array([1, 2, 3, 4]);
    try {
      await saveTorrentMeta(id, data);

      const file = await exportTorrentMeta(id, "Some/Torrent", outDir);

      expect(file).toBe(path.join(outDir, "Some Torrent.torrent"));
      await expect(fs.readFile(file!)).resolves.toEqual(Buffer.from(data));
    } finally {
      deleteTorrentMeta(id);
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("returns null when metadata has not arrived yet", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-export-missing-"));
    try {
      await expect(exportTorrentMeta("missing", "Missing", outDir)).resolves.toBeNull();
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});

describe("normalizeVia", () => {
  it('maps a legacy "realdebrid" item onto via+provider', () => {
    expect(normalizeVia("realdebrid")).toEqual({ via: "debrid", provider: "realdebrid" });
  });

  it('leaves a current "debrid" value alone and names no provider', () => {
    expect(normalizeVia("debrid")).toEqual({ via: "debrid" });
  });

  it("passes p2p through", () => {
    expect(normalizeVia("p2p")).toEqual({ via: "p2p" });
  });

  it("treats an absent or unrecognised value as p2p, the pre-debrid default", () => {
    expect(normalizeVia(undefined)).toEqual({ via: "p2p" });
    expect(normalizeVia("nonsense")).toEqual({ via: "p2p" });
  });
});
