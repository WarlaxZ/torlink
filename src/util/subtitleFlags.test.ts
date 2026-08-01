import { describe, expect, it } from "vitest";
import { subtitleArgs } from "./subtitleFlags";

const URL = "http://box.test:9161/stream/abc/1.vtt?k=cap";

describe("subtitleArgs", () => {
  it("uses --sub-file for mpv", () => {
    expect(subtitleArgs("mpv", URL)).toEqual([`--sub-file=${URL}`]);
  });

  it("uses --sub-file for mpv.net", () => {
    expect(subtitleArgs("mpvnet", URL)).toEqual([`--sub-file=${URL}`]);
  });

  it("uses --mpv-sub-file for IINA, which prefixes mpv's own flags", () => {
    expect(subtitleArgs("iina", URL)).toEqual([`--mpv-sub-file=${URL}`]);
  });

  it("gives VLC no flag at all", () => {
    // Measured against a real VLC 3.0.11: `--input-slave=<url>` loads the
    // subtitle as an AUDIO track ("loading audio-es slave"), and
    // `--sub-file=<url>` reaches the right track type but resolves the URL as
    // a local path, producing garbage. There is no VLC 3 CLI flag that
    // side-loads a subtitle from a URL, so passing one would silently
    // misbehave — worse than passing nothing.
    expect(subtitleArgs("vlc", URL)).toEqual([]);
  });

  it("recognises a player given as an absolute path", () => {
    // The configured command is often a full path on Windows and macOS.
    expect(subtitleArgs("/Applications/VLC.app/Contents/MacOS/VLC", URL)).toEqual([]);
    expect(subtitleArgs("C:\\Program Files\\VideoLAN\\VLC\\vlc.exe", URL)).toEqual([]);
  });

  it("recognises the macOS app-bundle names torlink launches with `open -a`", () => {
    expect(subtitleArgs("VLC", URL)).toEqual([]);
    expect(subtitleArgs("IINA", URL)).toEqual([`--mpv-sub-file=${URL}`]);
  });

  it("returns nothing for an unknown or custom command", () => {
    // A user's own wrapper script takes whatever arguments it takes. Guessing a
    // flag would break a launch that works today, so an unknown player gets the
    // URL alone and the caller says the subtitle was not attached.
    expect(subtitleArgs("my-player.sh", URL)).toEqual([]);
    expect(subtitleArgs("", URL)).toEqual([]);
  });

  it("returns nothing when there is no subtitle url", () => {
    expect(subtitleArgs("mpv", "")).toEqual([]);
  });
});
