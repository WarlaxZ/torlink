import { describe, it, expect } from "vitest";
import { parseTorrentsCsv } from "./torrentscsv";

// Shape confirmed against the live API / Jackett's TorrentsCSV indexer:
// { torrents: [{ infohash, name, size_bytes, seeders, leechers, created_unix }] }
const SAMPLE = {
  torrents: [
    {
      infohash: "AABBCCDDEEFF00112233445566778899AABBCCDD",
      name: "Inception 2010 1080p BluRay x264",
      size_bytes: 2147483648,
      seeders: 120,
      leechers: 8,
      created_unix: 1600000000,
    },
    {
      infohash: "1111111111111111111111111111111111111111",
      name: "Inception 2010 720p",
      size_bytes: 1073741824,
      seeders: null,
      leechers: null,
      created_unix: 1500000000,
    },
  ],
};

describe("parseTorrentsCsv", () => {
  it("maps fields, lowercases the infohash, and builds a magnet", () => {
    const [first] = parseTorrentsCsv(SAMPLE);
    expect(first).toMatchObject({
      infoHash: "aabbccddeeff00112233445566778899aabbccdd",
      name: "Inception 2010 1080p BluRay x264",
      sizeBytes: 2147483648,
      seeders: 120,
      leechers: 8,
      source: "torrents-csv",
      added: 1600000000,
    });
    expect(first!.magnet).toContain("xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd");
  });

  it("coerces null seeders/leechers to 0", () => {
    const results = parseTorrentsCsv(SAMPLE);
    expect(results[1]).toMatchObject({ seeders: 0, leechers: 0 });
  });

  it("skips rows without an infohash and tolerates an empty response", () => {
    expect(parseTorrentsCsv({ torrents: [{ name: "no hash" }] })).toEqual([]);
    expect(parseTorrentsCsv({})).toEqual([]);
  });
});
