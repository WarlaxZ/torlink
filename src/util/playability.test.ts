import { describe, expect, it } from "vitest";
import {
  BROWSER_PROFILE,
  CHROMECAST_PROFILE,
  blockersFor,
  castContentType,
  classifyFromName,
  extensionOf,
  type MediaFacts,
} from "./playability";

const facts = (over: Partial<MediaFacts> = {}): MediaFacts => ({
  container: "mp4",
  videoCodec: "h264",
  audioCodec: "aac",
  source: "name",
  subtitles: [],
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
      subtitles: [],
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
      subtitles: [],
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

  // THE REGRESSION GUARD for adding profiles to a module the web player depends
  // on: the no-argument form must answer exactly what it answered before they
  // existed. Every case above is already that guard; this one pins that naming
  // the browser profile explicitly is the same thing.
  it("defaults to the browser profile", () => {
    expect(blockersFor(facts({ audioCodec: "ac3" }))).toEqual(
      blockersFor(facts({ audioCodec: "ac3" }), BROWSER_PROFILE),
    );
    expect(blockersFor(facts({ audioCodec: "ac3" }))).toEqual(["audio"]);
  });
});

describe("blockersFor with the Chromecast profile", () => {
  it("blocks matroska for a Chromecast too — the device demuxes no more of it than a browser", () => {
    expect(blockersFor(facts({ container: "mkv" }), CHROMECAST_PROFILE)).toEqual(["container"]);
  });

  it("allows ac3 and eac3, which the browser refuses", () => {
    // The recorded trade-off: this is HDMI passthrough, so a television that
    // cannot take it plays silently. Blocking would instead REFUSE a file that
    // would almost certainly have played, and on the torrent backend there is
    // no transcode rung underneath to fall back to. Silence is recoverable in
    // one keypress; a refusal is not recoverable at all.
    expect(blockersFor(facts({ audioCodec: "ac3" }), CHROMECAST_PROFILE)).toEqual([]);
    expect(blockersFor(facts({ audioCodec: "eac3" }), CHROMECAST_PROFILE)).toEqual([]);
  });

  it("still blocks dts and truehd", () => {
    expect(blockersFor(facts({ audioCodec: "dts" }), CHROMECAST_PROFILE)).toEqual(["audio"]);
    expect(blockersFor(facts({ audioCodec: "truehd" }), CHROMECAST_PROFILE)).toEqual(["audio"]);
  });

  it("blocks hevc, because a model name is a guess and there is no video transcode", () => {
    expect(blockersFor(facts({ videoCodec: "hevc" }), CHROMECAST_PROFILE)).toEqual(["video"]);
    expect(blockersFor(facts({ videoCodec: "av1" }), CHROMECAST_PROFILE)).toEqual(["video"]);
  });

  it("is the pair that lets the browser's fallback card offer to cast", () => {
    // An mp4 carrying AC3: the browser refuses the audio, a Chromecast takes it.
    // This is the whole point of having two profiles rather than one list.
    const f = classifyFromName("Kestrel.2010.1080p.BluRay.x264.AC3.mp4");
    expect(blockersFor(f)).toEqual(["audio"]);
    expect(blockersFor(f, CHROMECAST_PROFILE)).toEqual([]);
  });

  it("agrees with the browser about an mkv, which neither can demux", () => {
    const f = classifyFromName("Kepler.S02E04.1080p.WEB-DL.mkv");
    expect(blockersFor(f)).toEqual(["container"]);
    expect(blockersFor(f, CHROMECAST_PROFILE)).toEqual(["container"]);
  });
});

describe("castContentType", () => {
  it("names the container for a direct play", () => {
    expect(castContentType("mp4", false)).toBe("video/mp4");
    expect(castContentType("m4v", false)).toBe("video/mp4");
    expect(castContentType("webm", false)).toBe("video/webm");
  });

  it("names HLS whenever the source is a manifest, whatever the file's own container", () => {
    expect(castContentType("mkv", true)).toBe("application/vnd.apple.mpegurl");
    expect(castContentType("mp4", true)).toBe("application/vnd.apple.mpegurl");
  });

  it("falls back to video/mp4 for a container it does not know, rather than an empty type", () => {
    // An empty contentType is a LOAD_FAILED with no reason. mp4 is the honest
    // guess: it is what a direct-play rung will have been chosen for.
    expect(castContentType("", false)).toBe("video/mp4");
  });
});
