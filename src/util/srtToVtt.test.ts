import { describe, expect, it } from "vitest";
import { decodeSubtitle, srtToVtt } from "./srtToVtt";

describe("srtToVtt", () => {
  it("adds the WEBVTT header", () => {
    expect(srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nHello\n")).toMatch(/^WEBVTT\n/);
  });

  it("converts comma decimals to dots in timestamps", () => {
    // The only difference between the two formats that actually stops a
    // browser parsing the file.
    const out = srtToVtt("1\n00:01:02,345 --> 00:01:04,567\nHello\n");
    expect(out).toContain("00:01:02.345 --> 00:01:04.567");
    expect(out).not.toContain(",345");
  });

  it("drops the numeric cue index lines", () => {
    const out = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond\n");
    expect(out).not.toMatch(/^\s*1\s*$/m);
    expect(out).not.toMatch(/^\s*2\s*$/m);
    expect(out).toContain("First");
    expect(out).toContain("Second");
  });

  it("keeps a numeric line that is dialogue, not an index", () => {
    // A cue whose text is "1998" must survive. Only a bare number IMMEDIATELY
    // followed by a timestamp line is an index.
    const out = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\n1998\n");
    expect(out).toContain("1998");
  });

  it("strips a UTF-8 BOM", () => {
    // A BOM before WEBVTT makes the browser reject the whole file.
    const out = srtToVtt("\uFEFF1\n00:00:01,000 --> 00:00:02,000\nHello\n");
    expect(out.startsWith("WEBVTT")).toBe(true);
  });

  it("normalises CRLF line endings", () => {
    const out = srtToVtt("1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n");
    expect(out).not.toContain("\r");
    expect(out).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("passes an existing WebVTT file through unchanged apart from newlines", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n";
    expect(srtToVtt(vtt)).toBe(vtt);
  });

  it("does not double the header on a WebVTT file with a BOM", () => {
    const out = srtToVtt("\uFEFFWEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n");
    expect(out.match(/WEBVTT/g)).toHaveLength(1);
  });

  it("keeps hour-less timestamps working", () => {
    // Some encoders write MM:SS,mmm. WebVTT allows it, so leave it alone apart
    // from the separator.
    expect(srtToVtt("1\n01:02,345 --> 01:04,567\nHi\n")).toContain("01:02.345 --> 01:04.567");
  });

  it("returns a bare header for empty input rather than an empty file", () => {
    expect(srtToVtt("")).toBe("WEBVTT\n");
  });
});

describe("decodeSubtitle", () => {
  it("decodes UTF-8", () => {
    const bytes = new TextEncoder().encode("Grüße");
    expect(decodeSubtitle(bytes)).toBe("Grüße");
  });

  it("falls back to latin1 for bytes that are not valid UTF-8", () => {
    // .srt files are frequently Windows-1252. Decoding those as UTF-8 yields
    // U+FFFD replacement characters, and a mojibake subtitle is worse than
    // none — so an invalid sequence means "this was never UTF-8".
    const latin1 = new Uint8Array([0x47, 0x72, 0xfc, 0xdf, 0x65]); // "Grüße" in latin1
    expect(decodeSubtitle(latin1)).toBe("Grüße");
  });

  it("does not mistake valid UTF-8 multibyte text for latin1", () => {
    const bytes = new TextEncoder().encode("日本語");
    expect(decodeSubtitle(bytes)).toBe("日本語");
  });
});
