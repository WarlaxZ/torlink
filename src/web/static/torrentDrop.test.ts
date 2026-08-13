import { describe, it, expect } from "vitest";
import { dragHasFiles, pickTorrentFile } from "./torrentDrop";

describe("dragHasFiles", () => {
  it("is true when the drag carries files (so the overlay should show)", () => {
    expect(dragHasFiles(["Files"])).toBe(true);
    expect(dragHasFiles(["text/plain", "Files"])).toBe(true);
  });
  it("is false for a text/link drag or nothing at all", () => {
    expect(dragHasFiles(["text/plain"])).toBe(false);
    expect(dragHasFiles([])).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });
});

describe("pickTorrentFile", () => {
  it("picks the first .torrent, case-insensitively", () => {
    const files = [{ name: "notes.txt" }, { name: "Kestrel.2010.TORRENT" }, { name: "b.torrent" }];
    expect(pickTorrentFile(files)?.name).toBe("Kestrel.2010.TORRENT");
  });
  it("ignores files that only contain 'torrent' in the middle of the name", () => {
    expect(pickTorrentFile([{ name: "my-torrent-notes.txt" }])).toBe(null);
  });
  it("returns null when nothing dropped is a .torrent", () => {
    expect(pickTorrentFile([{ name: "holiday.mp4" }, { name: "a.magnet" }])).toBe(null);
    expect(pickTorrentFile([])).toBe(null);
  });
});
