import { describe, expect, it } from "vitest";
import {
  absoluteUrl,
  chooseSource,
  detectPlatform,
  extensionOf,
  fallbackMessage,
  filesPath,
  infoPath,
  interruptedNotice,
  parsePlayerLocation,
  playlistPath,
  primaryAction,
  restPlaylistPath,
  routeFailure,
  streamPath,
  vlcLinks,
  type PlayerTarget,
} from "./playerModel";
import type { StreamInfoResponse } from "../wire";

const target = (over: Partial<PlayerTarget> = {}): PlayerTarget => ({
  sid: "sid-1",
  index: 0,
  capability: "cap-1",
  filename: "movie.mp4",
  ...over,
});

describe("parsePlayerLocation", () => {
  it("reads the session, index, capability and name", () => {
    expect(parsePlayerLocation("/play/abc/3", "?k=secret&n=Copper%20Kettle.mp4")).toEqual({
      sid: "abc",
      index: 3,
      capability: "secret",
      filename: "Copper Kettle.mp4",
    });
  });

  it("decodes an encoded session id", () => {
    expect(parsePlayerLocation("/play/a%2Fb/0", "")?.sid).toBe("a/b");
  });

  it("defaults a missing capability and name to empty", () => {
    expect(parsePlayerLocation("/play/abc/0", "")).toEqual({
      sid: "abc",
      index: 0,
      capability: "",
      filename: "",
    });
  });

  // The same rejections parseStreamPath makes on the server. A page that
  // accepted an index the server won't parse would render a player for a 404.
  it.each([
    "/play/abc",
    "/play/abc/",
    "/play/abc/-1",
    "/play/abc/1.5",
    "/play/abc/0x1",
    "/play/abc/length",
    "/play/abc/0/extra",
    "/play//0",
    "/play/a%ZZ/0",
    "/play/abc/99999999999999999999",
    "/stream/abc/0",
  ])("rejects %s", (p) => {
    expect(parsePlayerLocation(p, "")).toBeNull();
  });
});

describe("streamPath / playlistPath", () => {
  it("builds the handle with the capability", () => {
    expect(streamPath(target())).toBe("/stream/sid-1/0?k=cap-1");
    expect(playlistPath(target())).toBe("/stream/sid-1/0.m3u?k=cap-1");
  });

  it("encodes the session id and the capability", () => {
    const t = target({ sid: "a/b c", capability: "x y&z", index: 2 });
    expect(streamPath(t)).toBe("/stream/a%2Fb%20c/2?k=x%20y%26z");
    expect(playlistPath(t)).toBe("/stream/a%2Fb%20c/2.m3u?k=x%20y%26z");
  });

  it("omits the query when there is no capability", () => {
    expect(streamPath(target({ capability: "" }))).toBe("/stream/sid-1/0");
  });

  it("resolves against an origin without doubling the slash", () => {
    expect(absoluteUrl("http://box.local:9162", "/stream/a/0")).toBe(
      "http://box.local:9162/stream/a/0",
    );
    expect(absoluteUrl("http://box.local:9162/", "/stream/a/0")).toBe(
      "http://box.local:9162/stream/a/0",
    );
  });
});

describe("extensionOf", () => {
  it.each([
    ["movie.mp4", "mp4"],
    ["MOVIE.MKV", "mkv"],
    ["Show.S01E01.1080p.x265.mkv", "mkv"],
    ["no-extension", ""],
    ["trailing.", ""],
    [".hidden", ""],
    ["too.longextension", ""],
    ["weird.mp4?x=1", ""],
  ])("%s -> %s", (name, ext) => {
    expect(extensionOf(name)).toBe(ext);
  });
});

describe("infoPath", () => {
  it("is the stream handle plus .info, carrying the capability", () => {
    expect(infoPath(target())).toBe("/stream/sid-1/0.info?k=cap-1");
  });

  it("encodes a session id with a slash in it", () => {
    expect(infoPath(target({ sid: "a/b" }))).toBe("/stream/a%2Fb/0.info?k=cap-1");
  });

  it("omits the query entirely when there is no capability", () => {
    expect(infoPath(target({ capability: "" }))).toBe("/stream/sid-1/0.info");
  });
});

describe("restPlaylistPath", () => {
  it("appends to the capability's query string", () => {
    expect(restPlaylistPath(target())).toBe("/stream/sid-1/0.m3u?k=cap-1&rest=1");
  });

  it("starts a query string when there is no capability", () => {
    // A tokenless loopback server puts no ?k= on the URL, and "?k=&rest=1"
    // would be a capability the server reads as empty.
    expect(restPlaylistPath(target({ capability: "" }))).toBe("/stream/sid-1/0.m3u?rest=1");
  });
});

describe("filesPath", () => {
  it("is the stream handle plus .files, carrying the capability", () => {
    expect(filesPath(target())).toBe("/stream/sid-1/0.files?k=cap-1");
  });

  it("encodes a session id with a slash in it", () => {
    expect(filesPath(target({ sid: "a/b" }))).toBe("/stream/a%2Fb/0.files?k=cap-1");
  });

  it("omits the query entirely when there is no capability", () => {
    expect(filesPath(target({ capability: "" }))).toBe("/stream/sid-1/0.files");
  });
});

describe("chooseSource", () => {
  const info = (over: Partial<StreamInfoResponse> = {}): StreamInfoResponse => ({
    facts: { container: "mp4", videoCodec: "h264", audioCodec: "aac", source: "probe" as const, subtitles: [] },
    blockers: [],
    hls: null,
    subtitles: { embedded: [], files: [] },
    ...over,
  });

  it("plays a clean file directly", () => {
    expect(chooseSource(info(), "Ashfall.1999.1080p.mp4")).toEqual({
      rung: "direct",
      reason: null,
    });
  });

  it("prefers the provider's HLS over the card when the container is wrong", () => {
    const chosen = chooseSource(
      info({ blockers: ["container"], hls: "https://rd.example/x.m3u8" }),
      "Kestrel.2010.1080p.BluRay.x264.mkv",
    );
    expect(chosen).toEqual({ rung: "provider-hls", reason: null });
  });

  it("ignores an offered HLS when the file already plays directly", () => {
    // The provider's transcode is a re-encode. Taking it for a file the browser
    // can play losslessly would be a pointless quality loss.
    const chosen = chooseSource(
      info({ hls: "https://rd.example/x.m3u8" }),
      "Ashfall.1999.1080p.mp4",
    );
    expect(chosen.rung).toBe("direct");
  });

  it("falls to the card with the video reason when nothing else is available", () => {
    expect(
      chooseSource(
        info({
          facts: { container: "mp4", videoCodec: "hevc", audioCodec: "aac", source: "probe" as const, subtitles: [] },
          blockers: ["video"],
        }),
        "Tin.Rivers.2024.2160p.mp4",
      ),
    ).toEqual({ rung: "card", reason: "video-codec" });
  });

  it("names audio as the reason when audio is the only blocker", () => {
    expect(chooseSource(info({ blockers: ["audio"] }), "Kestrel.2010.1080p.mp4").reason).toBe(
      "audio-codec",
    );
  });

  it("names the container when it is among the blockers, because it is the one a user recognises", () => {
    expect(
      chooseSource(info({ blockers: ["container", "video", "audio"] }), "Tin.Rivers.2024.2160p.mkv")
        .reason,
    ).toBe("container");
  });

  it("falls back to the filename when .info could not be fetched", () => {
    // A phone that lost the network mid-load, or an older server. The page must
    // still do something sensible rather than showing nothing.
    expect(chooseSource(null, "Ashfall.1999.1080p.mp4")).toEqual({
      rung: "direct",
      reason: null,
    });
    expect(chooseSource(null, "Kestrel.2010.1080p.BluRay.x264.mkv")).toEqual({
      rung: "card",
      reason: "container",
    });
  });

  // The mutation guard the retired canDirectPlay tests used to carry: mkv is
  // most of what this app downloads and no shipping browser demuxes it, and an
  // unnamed file must be pessimistic rather than show a black rectangle.
  it.each(["release.mkv", "movie.avi", "movie.ts", "movie.wmv", "movie.mov", "", "unnamed"])(
    "cards %s when there is nothing better",
    (name) => {
      expect(chooseSource(null, name).rung).toBe("card");
    },
  );

  it.each(["movie.mp4", "movie.M4V", "clip.webm"])("plays %s directly", (name) => {
    expect(chooseSource(null, name).rung).toBe("direct");
  });
});

describe("detectPlatform", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "ios"],
    ["Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X)", "ios"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8)", "android"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "macos"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "other"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "other"],
    ["", "other"],
  ])("%s -> %s", (ua, platform) => {
    expect(detectPlatform(ua)).toBe(platform);
  });
});

describe("vlcLinks", () => {
  const url = "http://box.local:9162/stream/sid-1/0?k=cap-1";

  it("offers the x-callback scheme on iOS", () => {
    expect(vlcLinks(url, "ios")).toEqual([
      {
        id: "vlc-callback",
        label: "Open in VLC",
        href: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`,
      },
    ]);
  });

  // The platform is still detected; only what we offer it changed.
  it("still recognises a Mac", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
  });

  it("offers an intent on Android, carrying the original scheme", () => {
    expect(vlcLinks(url, "android")).toEqual([
      {
        id: "vlc-intent",
        label: "Open in VLC",
        href: "intent://box.local:9162/stream/sid-1/0?k=cap-1#Intent;package=org.videolan.vlc;scheme=http;end",
      },
    ]);
  });

  it("keeps https in the intent's scheme parameter", () => {
    const href = vlcLinks("https://box.example/stream/a/0?k=c", "android")[0]!.href;
    expect(href).toContain("scheme=https;");
    expect(href.startsWith("intent://box.example/stream/a/0?k=c#Intent;")).toBe(true);
  });

  // `;` terminates an intent parameter and `#` starts the fragment, so either
  // one surviving from the URL would truncate the intent into something that
  // opens the wrong thing (or nothing).
  it("escapes intent-delimiter characters out of the URL", () => {
    const href = vlcLinks("http://h/stream/a/0?k=x;y#z", "android")[0]!.href;
    expect(href).toBe("intent://h/stream/a/0?k=x%3By#Intent;package=org.videolan.vlc;scheme=http;end");
    expect(href.split("#Intent;")).toHaveLength(2);
  });

  /**
   * NO DESKTOP REGISTERS A VLC URL SCHEME, macOS included — which is where this
   * was wrong: macOS sat in the iOS branch above and got `vlc-x-callback://`, a
   * scheme belonging to the iOS app alone, so the click was a silent no-op.
   * Verified against a real install: VLC.app's Info.plist registers http, https,
   * ftp, mms, mmsh, rtsp, udp, rtp, rtmp*, sftp and smb, and nothing else. A
   * button here is a button that does nothing, so there is no button.
   */
  it("offers nothing on desktop, macOS included", () => {
    for (const platform of ["macos", "other"] as const) {
      expect(vlcLinks(url, platform)).toEqual([]);
    }
  });

  it("offers no intent for a URL that is not http(s)", () => {
    expect(vlcLinks("file:///tmp/x.mp4", "android")).toEqual([]);
    expect(vlcLinks("not a url", "android")).toEqual([]);
  });
});

describe("fallbackMessage", () => {
  it("names the file and stays honest about the cause", () => {
    expect(fallbackMessage("container", "release.mkv")).toContain("release.mkv");
    expect(fallbackMessage("container", "release.mkv")).toContain("MKV");
    expect(fallbackMessage("error", "a.mp4")).toContain("can't decode");
    expect(fallbackMessage("stall", "a.mp4")).toContain("produced nothing");
  });

  it("survives an unnamed file", () => {
    expect(fallbackMessage("container", "")).toContain("This file");
  });

  it("tells a user with a capability-less link what to do", () => {
    expect(fallbackMessage("no-link", "")).toContain("reopen the player");
  });

  /**
   * The server already probed this file and told us exactly what it is, and the
   * card was still guessing in prose — "most releases are MKV with HEVC or DTS
   * audio", "HEVC or AV1", "usually DTS or TrueHD". Naming the real codec is the
   * difference between a message a user can act on (search for an x264 release)
   * and one they can only accept.
   */
  it("names the codec the server actually found", () => {
    const facts = { container: "mkv", videoCodec: "hevc", audioCodec: "dts", source: "probe" as const, subtitles: [] };
    expect(fallbackMessage("video-codec", "a.mkv", facts)).toContain("HEVC");
    expect(fallbackMessage("video-codec", "a.mkv", facts)).not.toContain("or AV1");
    expect(fallbackMessage("audio-codec", "a.mkv", facts)).toContain("DTS");
    expect(fallbackMessage("audio-codec", "a.mkv", facts)).not.toContain("usually");
    expect(fallbackMessage("container", "a.mkv", facts)).toContain("MKV");
  });

  /**
   * A guess is labelled as one. `source: "name"` means the codec was inferred
   * from the release name, and a release named x265 can carry something else —
   * so the card must not state it as fact the way a probe result is stated.
   */
  it("hedges a codec that was only inferred from the release name", () => {
    const guessed = { container: "mkv", videoCodec: "hevc", audioCodec: "", source: "name" as const, subtitles: [] };
    expect(fallbackMessage("video-codec", "a.mkv", guessed)).toContain("looks like");
  });

  it("falls back to the old prose when the server told us nothing", () => {
    const unknown = { container: "", videoCodec: "", audioCodec: "", source: "name" as const, subtitles: [] };
    expect(fallbackMessage("video-codec", "a.mkv", unknown)).toContain("HEVC or AV1");
    expect(fallbackMessage("video-codec", "a.mkv")).toContain("HEVC or AV1");
  });
});

describe("routeFailure", () => {
  it("replaces a player that never started", () => {
    expect(routeFailure(false)).toBe("card");
  });

  // The regression this whole pair exists for: the wiring used to latch on the
  // first `playing` event and then drop every later failure, so a stream that
  // died partway through froze in silence.
  it("annotates a player that had already started, rather than destroying it", () => {
    expect(routeFailure(true)).toBe("notice");
  });
});

// A failure that arrives AFTER playback started is a different message from the
// startup card: the user has already seen the film run, so "browsers can't play
// this container" would be a lie. It also has to point somewhere useful, because
// the frozen <video> is staying on screen.
describe("interruptedNotice", () => {
  it("says playback stopped rather than blaming the container", () => {
    const notice = interruptedNotice("error");
    expect(notice).toContain("stopped");
    expect(notice).not.toContain("container");
  });

  /**
   * Specifically the `.m3u`, and NOT VLC. Desktop has no VLC button any more —
   * no desktop registers the scheme — so naming one sends the user looking for a
   * control that is not on screen. The `.m3u` button is there on every platform.
   */
  it("points at the hand-off that does work, and names no absent button", () => {
    for (const reason of ["error", "stall"] as const) {
      expect(interruptedNotice(reason)).toContain(".m3u");
      expect(interruptedNotice(reason)).not.toContain("VLC");
    }
  });

  it("distinguishes a stall from an outright failure", () => {
    expect(interruptedNotice("stall")).not.toBe(interruptedNotice("error"));
  });
});

describe("primaryAction", () => {
  /**
   * On a phone the three controls were in the wrong order twice over: a
   * downloaded .m3u is not handed to a media player the way a desktop OS does
   * it, "Copy stream URL" is a riddle rather than an action, and the one that
   * works was last.
   */
  it("leads with VLC on the platforms that have a working scheme", () => {
    expect(primaryAction("ios")).toBe("vlc");
    expect(primaryAction("android")).toBe("vlc");
  });

  it("leads with the .m3u on desktop, where vlcLinks offers nothing", () => {
    // "other" is Windows and Linux — see Platform. Neither registers a
    // vlc://-style scheme, so the .m3u is the only control that works there.
    expect(primaryAction("other")).toBe("m3u");
  });

  /**
   * macOS is a desktop, and `vlcLinks` returns nothing for it — the
   * vlc-x-callback scheme belongs to VLC's iOS app, not the desktop one. So
   * there is no VLC button to lead with even if this said otherwise.
   */
  it("keeps the .m3u first on macOS", () => {
    expect(primaryAction("macos")).toBe("m3u");
    expect(vlcLinks("http://x/y", "macos")).toEqual([]);
  });
});
