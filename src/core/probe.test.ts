import { describe, expect, it } from "vitest";
import { ffprobeArgs, parseFfprobe, probeUrl } from "./probe";

const output = (
  formatName: string,
  streams: {
    codec_type: string;
    codec_name: string;
    tags?: { language?: string; title?: string };
  }[],
) => JSON.stringify({ format: { format_name: formatName }, streams });

describe("ffprobeArgs", () => {
  it("asks for json, quietly, and bounds how much it reads", () => {
    const args = ffprobeArgs("https://cdn.example/Kestrel.mkv");
    expect(args).toContain("-print_format");
    expect(args).toContain("json");
    // A bounded probe matters: this reads over the network from a CDN or a
    // half-downloaded torrent, and an unbounded analyzeduration will sit there.
    expect(args).toContain("-analyzeduration");
    expect(args).toContain("-probesize");
    // The URL is the last argument and is never shell-interpolated.
    expect(args[args.length - 1]).toBe("https://cdn.example/Kestrel.mkv");
  });

  it("passes a url with shell metacharacters through untouched", () => {
    const args = ffprobeArgs("https://cdn.example/a b;rm -rf.mkv");
    expect(args[args.length - 1]).toBe("https://cdn.example/a b;rm -rf.mkv");
  });
});

describe("parseFfprobe", () => {
  it("reads h264 and aac out of an mp4", () => {
    const facts = parseFfprobe(
      output("mov,mp4,m4a,3gp,3g2,mj2", [
        { codec_type: "video", codec_name: "h264" },
        { codec_type: "audio", codec_name: "aac" },
      ]),
      "mp4",
    );
    expect(facts).toEqual({
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      source: "probe",
      subtitles: [],
    });
  });

  it("reads hevc and dts out of a matroska file", () => {
    const facts = parseFfprobe(
      output("matroska,webm", [
        { codec_type: "video", codec_name: "hevc" },
        { codec_type: "audio", codec_name: "dts" },
      ]),
      "mkv",
    );
    expect(facts?.videoCodec).toBe("hevc");
    expect(facts?.audioCodec).toBe("dts");
    expect(facts?.container).toBe("mkv");
  });

  it("normalises avc1 to h264", () => {
    const facts = parseFfprobe(
      output("mov,mp4,m4a,3gp,3g2,mj2", [{ codec_type: "video", codec_name: "avc1" }]),
      "mp4",
    );
    expect(facts?.videoCodec).toBe("h264");
  });

  it("picks the worst audio track, not the first", () => {
    // A dual-audio release: the browser may select either, so the one it cannot
    // decode is the one that decides the answer.
    const facts = parseFfprobe(
      output("matroska,webm", [
        { codec_type: "video", codec_name: "h264" },
        { codec_type: "audio", codec_name: "aac" },
        { codec_type: "audio", codec_name: "truehd" },
      ]),
      "mkv",
    );
    expect(facts?.audioCodec).toBe("truehd");
  });

  it("reports subtitle streams instead of discarding them", () => {
    // This test used to assert the opposite. Subtitle rows were dropped, so a
    // file with three muxed tracks looked identical to one with none, and the
    // player page could not tell the user they existed. Attachment streams
    // (fonts, cover art) are still ignored — they are not tracks.
    const facts = parseFfprobe(
      output("mov,mp4", [
        { codec_type: "video", codec_name: "hevc" },
        { codec_type: "audio", codec_name: "eac3" },
        { codec_type: "subtitle", codec_name: "mov_text", tags: { language: "spa" } },
        { codec_type: "subtitle", codec_name: "mov_text", tags: { language: "eng" } },
        { codec_type: "attachment", codec_name: "ttf" },
      ]),
      "mp4",
    );
    expect(facts?.subtitles).toEqual([
      { language: "spa", label: "" },
      { language: "eng", label: "" },
    ]);
  });

  it("keeps a subtitle stream's title tag as its label", () => {
    const facts = parseFfprobe(
      output("matroska,webm", [
        { codec_type: "video", codec_name: "h264" },
        { codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng", title: "SDH" } },
      ]),
      "mkv",
    );
    expect(facts?.subtitles).toEqual([{ language: "eng", label: "SDH" }]);
  });

  it("reports an untagged subtitle stream with an empty language", () => {
    // Present but unnamed is still information: the player can say "1 subtitle
    // track" rather than nothing.
    const facts = parseFfprobe(
      output("matroska,webm", [
        { codec_type: "video", codec_name: "h264" },
        { codec_type: "subtitle", codec_name: "subrip" },
      ]),
      "mkv",
    );
    expect(facts?.subtitles).toEqual([{ language: "", label: "" }]);
  });

  it("reports an empty subtitle list for a file with none", () => {
    const facts = parseFfprobe(
      output("matroska,webm", [{ codec_type: "video", codec_name: "h264" }]),
      "mkv",
    );
    expect(facts?.subtitles).toEqual([]);
  });

  it("asks ffprobe for the language and title tags", () => {
    // Without this the tags are absent from the JSON and every track reports an
    // empty language — the failure would look like "no subtitles have names".
    const entries = ffprobeArgs("http://example.test/a.mkv")[
      ffprobeArgs("http://example.test/a.mkv").indexOf("-show_entries") + 1
    ];
    expect(entries).toContain("stream_tags=language,title");
  });

  it("returns null on output that is not json", () => {
    expect(parseFfprobe("ffprobe: command failed", "mkv")).toBeNull();
  });

  it("returns null when there is no video stream at all", () => {
    // An audio-only or metadata-only response means the probe did not reach the
    // media; classifying from it would be worse than falling back to the name.
    expect(parseFfprobe(output("matroska,webm", []), "mkv")).toBeNull();
  });

  it("returns null on json that is not an object with streams", () => {
    expect(parseFfprobe("null", "mkv")).toBeNull();
    expect(parseFfprobe("[]", "mkv")).toBeNull();
    expect(parseFfprobe("42", "mkv")).toBeNull();
  });
});

describe("probeUrl", () => {
  it("returns null when there is no ffprobe, without running anything", async () => {
    let ran = false;
    const facts = await probeUrl("https://cdn.example/a.mkv", "mkv", {
      findImpl: async () => null,
      runImpl: async () => {
        ran = true;
        return "";
      },
    });
    expect(facts).toBeNull();
    expect(ran).toBe(false);
  });

  it("returns null when ffprobe rejects, rather than throwing", async () => {
    const facts = await probeUrl("https://cdn.example/a.mkv", "mkv", {
      findImpl: async () => "ffprobe",
      runImpl: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    expect(facts).toBeNull();
  });

  it("parses a successful run", async () => {
    const facts = await probeUrl("https://cdn.example/a.mkv", "mkv", {
      findImpl: async () => "ffprobe",
      runImpl: async () => output("matroska,webm", [{ codec_type: "video", codec_name: "h264" }]),
    });
    expect(facts?.source).toBe("probe");
  });

  it("passes the found binary and the built argv to the runner", async () => {
    let seen: { bin: string; args: string[] } | null = null;
    await probeUrl("https://cdn.example/a.mkv", "mkv", {
      findImpl: async () => "/opt/ffmpeg/bin/ffprobe",
      runImpl: async (bin, args) => {
        seen = { bin, args };
        return output("matroska,webm", [{ codec_type: "video", codec_name: "h264" }]);
      },
    });
    expect(seen!.bin).toBe("/opt/ffmpeg/bin/ffprobe");
    expect(seen!.args[seen!.args.length - 1]).toBe("https://cdn.example/a.mkv");
  });
});
