import { describe, expect, it } from "vitest";
import { isVideoFilename, pickStreamFile, streamCandidates } from "./videoFiles";
// Imported through util/player.ts as well, because that is the import site every
// Node caller uses and a re-export that stopped re-exporting would typecheck
// nowhere but here.
import { streamCandidates as viaPlayer } from "./player";

describe("isVideoFilename", () => {
  it("matches on the last extension, case-insensitively", () => {
    expect(isVideoFilename("Movie.2024.1080p.MKV")).toBe(true);
    expect(isVideoFilename("movie.mkv.nfo")).toBe(false);
    expect(isVideoFilename("no-extension")).toBe(false);
  });
});

describe("the shared heuristic", () => {
  // THE REASON THIS MODULE EXISTS. The TUI's picker and the web dashboard's
  // picker are the same decision, and the previous three times a decision was
  // copied instead of shared in this codebase it drifted (uploadSpeed, the byte
  // formatter, the progress unit). The two front-ends hold different types for a
  // file, so the shared function is generic over the shape and hands back the
  // caller's own objects — which is what lets the browser keep the `index` that
  // addresses the file on the server.
  it("preserves the caller's own element type and its extra fields", () => {
    const files = [
      { filename: "readme.nfo", bytes: 1, index: 0, handle: "/stream/s/0" },
      { filename: "movie.mkv", bytes: 9, index: 1, handle: "/stream/s/1" },
    ];
    expect(streamCandidates(files)).toEqual([files[1]]);
    expect(pickStreamFile(files)?.index).toBe(1);
  });

  it("is the same function util/player.ts exports", () => {
    expect(viaPlayer).toBe(streamCandidates);
  });

  it("never hands back the caller's array, so a caller can sort its copy", () => {
    const files = [{ filename: "a.bin", bytes: 1 }];
    expect(streamCandidates(files)).not.toBe(files);
  });
});
