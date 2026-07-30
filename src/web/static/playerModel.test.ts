import { describe, expect, it } from "vitest";
import {
  absoluteUrl,
  canDirectPlay,
  detectPlatform,
  extensionOf,
  fallbackMessage,
  parsePlayerLocation,
  playlistPath,
  streamPath,
  vlcLinks,
  type PlayerTarget,
} from "./playerModel";

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

describe("canDirectPlay", () => {
  it.each(["movie.mp4", "movie.M4V", "clip.webm"])("attempts %s", (name) => {
    expect(canDirectPlay(name)).toBe(true);
  });

  // The mutation guard for "direct-play attempted for every extension". mkv is
  // the case that matters: it is most of what this app downloads and no
  // shipping browser demuxes it.
  it.each(["release.mkv", "movie.avi", "movie.ts", "movie.wmv", "movie.mov", "", "unnamed"])(
    "falls back for %s",
    (name) => {
      expect(canDirectPlay(name)).toBe(false);
    },
  );
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

  it("offers the x-callback scheme on iOS and macOS", () => {
    for (const platform of ["ios", "macos"] as const) {
      expect(vlcLinks(url, platform)).toEqual([
        {
          id: "vlc-callback",
          label: "Open in VLC",
          href: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`,
        },
      ]);
    }
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

  // Desktop Windows and Linux register no VLC URL scheme; a button there is a
  // button that does nothing.
  it("offers nothing on other platforms", () => {
    expect(vlcLinks(url, "other")).toEqual([]);
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
});
