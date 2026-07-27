import { describe, it, expect } from "vitest";
import { HELP_TEXT, parseCliArgs } from "./args";

describe("parseCliArgs", () => {
  it("defaults to run with no args", () => {
    expect(parseCliArgs([])).toEqual({ kind: "run", web: false });
  });
  it("parses version and help flags", () => {
    expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
  });
  it("launches a magnet", () => {
    expect(parseCliArgs(["magnet:?xt=urn:btih:abc"])).toEqual({
      kind: "run",
      initialMagnet: "magnet:?xt=urn:btih:abc",
      web: false,
    });
  });
  it("launches a .torrent file", () => {
    expect(parseCliArgs(["./Foo.torrent"])).toEqual({
      kind: "run",
      initialTorrent: "./Foo.torrent",
      web: false,
    });
  });
  it("launches a bare infohash as a magnet (DHT)", () => {
    const hash = "abcdef0123456789abcdef0123456789abcdef01";
    expect(parseCliArgs([hash])).toEqual({ kind: "run", initialMagnet: hash, web: false });
  });
  it("rejects unknown arguments", () => {
    expect(parseCliArgs(["--nope"])).toEqual({ kind: "invalid", arg: "--nope" });
  });
  it("rejects a non-hash bareword", () => {
    expect(parseCliArgs(["hello"])).toEqual({ kind: "invalid", arg: "hello" });
  });
  it("parses attach", () => {
    expect(parseCliArgs(["attach"])).toEqual({ kind: "attach" });
  });
  it("parses update, with and without --force", () => {
    expect(parseCliArgs(["update"])).toEqual({ kind: "update", force: false });
    expect(parseCliArgs(["update", "--force"])).toEqual({ kind: "update", force: true });
  });
  it("parses import-netflix with a file path", () => {
    expect(parseCliArgs(["import-netflix", "/home/me/NetflixViewingActivity.csv"])).toEqual({
      kind: "import-netflix",
      file: "/home/me/NetflixViewingActivity.csv",
    });
  });
  it("rejects import-netflix with no file", () => {
    expect(parseCliArgs(["import-netflix"])).toEqual({
      kind: "invalid",
      arg: "import-netflix (missing file)",
    });
  });
  it("parses import-trakt", () => {
    expect(parseCliArgs(["import-trakt"])).toEqual({ kind: "import-trakt" });
  });
  it("parses watch with a directory", () => {
    expect(parseCliArgs(["watch", "/srv/blackhole"])).toEqual({
      kind: "watch",
      dir: "/srv/blackhole",
      downloadDir: undefined,
      seedTimeMs: undefined,
      deleteFiles: false,
      daemon: false,
    });
  });
  it("parses watch with a --to download dir", () => {
    expect(parseCliArgs(["watch", "/srv/blackhole", "--to", "/mnt/media"])).toEqual({
      kind: "watch",
      dir: "/srv/blackhole",
      downloadDir: "/mnt/media",
      seedTimeMs: undefined,
      deleteFiles: false,
      daemon: false,
    });
    expect(parseCliArgs(["watch", "--dir", "/mnt/media", "/srv/blackhole"])).toEqual({
      kind: "watch",
      dir: "/srv/blackhole",
      downloadDir: "/mnt/media",
      seedTimeMs: undefined,
      deleteFiles: false,
      daemon: false,
    });
  });
  it("parses watch --seed-time, --delete-files, and --daemon", () => {
    expect(
      parseCliArgs(["watch", "/srv/bh", "--seed-time", "1h", "--delete-files", "--daemon"]),
    ).toEqual({
      kind: "watch",
      dir: "/srv/bh",
      downloadDir: undefined,
      seedTimeMs: 3_600_000,
      deleteFiles: true,
      daemon: true,
    });
  });
  it("ignores an unparseable --seed-time", () => {
    expect(parseCliArgs(["watch", "/srv/bh", "--seed-time", "soon"])).toEqual({
      kind: "watch",
      dir: "/srv/bh",
      downloadDir: undefined,
      seedTimeMs: undefined,
      deleteFiles: false,
      daemon: false,
    });
  });
  it("rejects watch with no directory", () => {
    expect(parseCliArgs(["watch"])).toEqual({
      kind: "invalid",
      arg: "watch (missing directory)",
    });
  });
  it("parses serve with defaults", () => {
    expect(parseCliArgs(["serve"])).toEqual({
      kind: "serve",
      port: undefined,
      host: undefined,
      token: undefined,
      downloadDir: undefined,
      seedTimeMs: undefined,
      deleteFiles: false,
      daemon: false,
    });
  });
  it("parses serve flags", () => {
    expect(
      parseCliArgs([
        "serve",
        "--port",
        "9999",
        "--host",
        "0.0.0.0",
        "--token",
        "s3cret",
        "--to",
        "/mnt/media",
        "--seed-time",
        "30m",
      ]),
    ).toEqual({
      kind: "serve",
      port: 9999,
      host: "0.0.0.0",
      token: "s3cret",
      downloadDir: "/mnt/media",
      seedTimeMs: 1_800_000,
      deleteFiles: false,
      daemon: false,
    });
  });
  it("ignores a bad --port", () => {
    expect(parseCliArgs(["serve", "--port", "abc"]).kind).toBe("serve");
    expect((parseCliArgs(["serve", "--port", "abc"]) as { port?: number }).port).toBeUndefined();
  });
  it("parses files with defaults", () => {
    expect(parseCliArgs(["files"])).toEqual({
      kind: "files",
      port: undefined,
      host: undefined,
      token: undefined,
      dir: undefined,
      daemon: false,
    });
  });
  it("parses files flags", () => {
    expect(
      parseCliArgs([
        "files",
        "--port",
        "9160",
        "--host",
        "0.0.0.0",
        "--token",
        "s3cret",
        "--dir",
        "/mnt/media",
        "--daemon",
      ]),
    ).toEqual({
      kind: "files",
      port: 9160,
      host: "0.0.0.0",
      token: "s3cret",
      dir: "/mnt/media",
      daemon: true,
    });
  });
});

describe("web flags", () => {
  it("enables the web UI on serve", () => {
    expect(parseCliArgs(["serve", "--web"])).toMatchObject({ kind: "serve", web: true });
  });

  it("defaults serve web to off", () => {
    expect(parseCliArgs(["serve"])).toMatchObject({ kind: "serve", web: false });
  });

  it("reads a web port and token on serve", () => {
    expect(
      parseCliArgs(["serve", "--web", "--web-port", "8080", "--token", "s3cret"]),
    ).toMatchObject({
      kind: "serve",
      web: true,
      webPort: 8080,
      token: "s3cret",
    });
  });

  it("enables the web UI alongside the TUI", () => {
    expect(parseCliArgs(["--web"])).toMatchObject({ kind: "run", web: true });
  });

  it("reads a web port and token for the TUI", () => {
    expect(
      parseCliArgs([
        "--web",
        "--web-port",
        "8080",
        "--web-host",
        "0.0.0.0",
        "--token",
        "s3cret",
      ]),
    ).toMatchObject({
      kind: "run",
      web: true,
      webPort: 8080,
      webHost: "0.0.0.0",
      webToken: "s3cret",
    });
  });

  it("still treats a bare magnet as a run", () => {
    expect(parseCliArgs(["magnet:?xt=urn:btih:abc"])).toMatchObject({
      kind: "run",
      initialMagnet: "magnet:?xt=urn:btih:abc",
    });
  });

  it("rejects an invalid web port rather than binding a random one", () => {
    expect(parseCliArgs(["serve", "--web", "--web-port", "nope"])).toMatchObject({
      kind: "serve",
      web: true,
      webPort: undefined,
    });
  });

  // --- flag ordering: a magnet and --web must combine, in either order ---

  it("combines a magnet with --web when the magnet comes first", () => {
    expect(parseCliArgs(["magnet:?xt=urn:btih:abc", "--web"])).toMatchObject({
      kind: "run",
      initialMagnet: "magnet:?xt=urn:btih:abc",
      web: true,
    });
  });

  it("combines a magnet with --web when --web comes first", () => {
    expect(parseCliArgs(["--web", "magnet:?xt=urn:btih:abc"])).toMatchObject({
      kind: "run",
      initialMagnet: "magnet:?xt=urn:btih:abc",
      web: true,
    });
  });

  it("combines a .torrent path and an infohash with web flags", () => {
    expect(parseCliArgs(["./Foo.torrent", "--web", "--web-port", "8080"])).toMatchObject({
      kind: "run",
      initialTorrent: "./Foo.torrent",
      web: true,
      webPort: 8080,
    });
    const hash = "abcdef0123456789abcdef0123456789abcdef01";
    expect(parseCliArgs(["--web-host", "127.0.0.1", "--web", hash])).toMatchObject({
      kind: "run",
      initialMagnet: hash,
      web: true,
      webHost: "127.0.0.1",
    });
  });

  it("takes web flags without --web, so a mount site can still ignore them", () => {
    expect(parseCliArgs(["--web-port", "8080"])).toMatchObject({
      kind: "run",
      web: false,
      webPort: 8080,
    });
  });

  // --- strictness: never silently swallow an unknown flag ---

  it("still rejects an unknown flag that has a value after it", () => {
    expect(parseCliArgs(["--nope", "value"])).toEqual({ kind: "invalid", arg: "--nope" });
  });

  it("rejects a web value flag with no value", () => {
    expect(parseCliArgs(["--web", "--web-port"])).toEqual({
      kind: "invalid",
      arg: "--web-port (missing value)",
    });
  });

  it("rejects a second positional argument", () => {
    expect(parseCliArgs(["magnet:?xt=urn:btih:abc", "./Foo.torrent"])).toEqual({
      kind: "invalid",
      arg: "./Foo.torrent",
    });
  });

  it("rejects a non-hash bareword even with --web", () => {
    expect(parseCliArgs(["--web", "hello"])).toEqual({ kind: "invalid", arg: "hello" });
  });

  // --- token spellings and precedence ---

  it("accepts --web-token as a spelling of the TUI web token", () => {
    expect(parseCliArgs(["--web", "--web-token", "s3cret"])).toMatchObject({
      kind: "run",
      web: true,
      webToken: "s3cret",
    });
  });

  it("prefers the more specific --web-token over --token", () => {
    expect(parseCliArgs(["--web", "--token", "general", "--web-token", "specific"])).toMatchObject({
      kind: "run",
      web: true,
      webToken: "specific",
    });
  });

  it("does not read a token from the environment (mount sites do that)", () => {
    const prev = process.env.TORLINK_API_TOKEN;
    process.env.TORLINK_API_TOKEN = "from-env";
    try {
      expect(parseCliArgs(["--web"])).toMatchObject({ kind: "run", web: true, webToken: undefined });
      expect(parseCliArgs(["serve", "--web"])).toMatchObject({ kind: "serve", token: undefined });
    } finally {
      if (prev === undefined) delete process.env.TORLINK_API_TOKEN;
      else process.env.TORLINK_API_TOKEN = prev;
    }
  });

  // --- port validation on both commands ---

  it("rejects a non-positive web port on both commands", () => {
    expect(parseCliArgs(["serve", "--web", "--web-port", "0"])).toMatchObject({
      web: true,
      webPort: undefined,
    });
    expect(parseCliArgs(["--web", "--web-port", "-1"])).toMatchObject({
      web: true,
      webPort: undefined,
    });
    expect(parseCliArgs(["--web", "--web-port", "nope"])).toMatchObject({
      web: true,
      webPort: undefined,
    });
  });

  it("leaves serve's api port and host alone when --web is on", () => {
    expect(
      parseCliArgs(["serve", "--web", "--web-port", "8080", "--port", "9999", "--host", "0.0.0.0"]),
    ).toMatchObject({
      kind: "serve",
      web: true,
      webPort: 8080,
      port: 9999,
      host: "0.0.0.0",
    });
  });

  it("keeps --web out of serve's other flag values", () => {
    // If --web were not a valueless boolean it would eat the next token.
    expect(parseCliArgs(["serve", "--web", "--to", "/mnt/media"])).toMatchObject({
      kind: "serve",
      web: true,
      downloadDir: "/mnt/media",
    });
  });
});

describe("HELP_TEXT", () => {
  it("documents the web UI on both hosts", () => {
    expect(HELP_TEXT).toContain("torlnk --web");
    expect(HELP_TEXT).toContain("torlnk serve --web");
    expect(HELP_TEXT).toContain("--web-port <n>");
    expect(HELP_TEXT).toContain("--web-host <addr>");
  });
});
