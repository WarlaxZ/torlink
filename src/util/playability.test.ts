import { describe, expect, it } from "vitest";
import { blockersFor, classifyFromName, extensionOf, type MediaFacts } from "./playability";

const facts = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  container: "mp4",
  videoCodec: "h264",
  audioCodec: "aac",
  source: "name",
  ...over,
});

describe("extensionOf", () => {
  it("lowercases and drops the dot", () => {
    expect(extensionOf("Kestrel.2010.1080p.BluRay.x264.MKV")).toBe("mkv");
  });

  it("is empty when there is no usable extension", () => {
    expect(extensionOf("Kestrel")).toBe("");
  });
});

describe("classifyFromName", () => {
  it("reads an x264 release as h264", () => {
    expect(classifyFromName("Kestrel.2010.1080p.BluRay.x264.mkv")).toEqual({
      container: "mkv",
      videoCodec: "h264",
      audioCodec: "",
      source: "name",
    });
  });

  it("reads Atmos as truehd, the codec that actually carries it", () => {
    const f = classifyFromName("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP.mkv");
    expect(f.audioCodec).toBe("truehd");
  });

  it("does not infer a video codec from a resolution", () => {
    // This 4K release is HEVC in practice, but its NAME does not say so — and
    // "2160p therefore HEVC" is a guess, not a fact. Leaving it empty means the
    // file is blocked on its container only, and the ffprobe path is what turns
    // the guess into knowledge. Guessing here would mean showing a "can't decode
    // the video" card for a 4K H.264 file that would have played.
    const f = classifyFromName("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP.mkv");
    expect(f.videoCodec).toBe("");
  });

  it("prefers an explicit release name over the filename", () => {
    // The debrid provider often renames the file; the release name is the
    // richer signal and the caller has both.
    const f = classifyFromName("1.mkv", "Tin.Rivers.2024.2160p.WEB-DL.x265.DTS-GROUP");
    expect(f.videoCodec).toBe("hevc");
    expect(f.audioCodec).toBe("dts");
    expect(f.container).toBe("mkv");
  });

  it("leaves a codec empty rather than guessing when the name says nothing", () => {
    expect(classifyFromName("Ashfall.1999.1080p.mp4").videoCodec).toBe("");
  });

  it("survives a name the release parser refuses outright", () => {
    // parseRelease returns null when no usable title survives — a name that was
    // only quality noise. The container must still come through.
    expect(classifyFromName("1080p.x264.mkv")).toEqual({
      container: "mkv",
      videoCodec: "",
      audioCodec: "",
      source: "name",
    });
  });
});

describe("blockersFor", () => {
  it("clears a browser-safe mp4", () => {
    expect(blockersFor(facts())).toEqual([]);
  });

  it("blocks matroska on the container", () => {
    expect(blockersFor(facts({ container: "mkv" }))).toEqual(["container"]);
  });

  it("blocks an unknown container, because optimism there costs a black rectangle", () => {
    expect(blockersFor(facts({ container: "" }))).toEqual(["container"]);
  });

  it("blocks hevc in an mp4 — a container browsers take carrying a codec they do not", () => {
    expect(blockersFor(facts({ videoCodec: "hevc" }))).toEqual(["video"]);
  });

  it("blocks dts audio", () => {
    expect(blockersFor(facts({ audioCodec: "dts" }))).toEqual(["audio"]);
  });

  it("reports every blocker, not just the first", () => {
    expect(
      blockersFor(facts({ container: "mkv", videoCodec: "hevc", audioCodec: "truehd" })),
    ).toEqual(["container", "video", "audio"]);
  });

  it("does not block on an unknown codec", () => {
    // A release name that says nothing about audio is the common case. Guessing
    // pessimistically here would send files to the card that play fine today;
    // the runtime error/stall detection is what covers being wrong.
    expect(blockersFor(facts({ videoCodec: "", audioCodec: "" }))).toEqual([]);
  });
});
