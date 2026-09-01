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
  it("parses headless searches", () => {
    expect(parseCliArgs(["search", "ubuntu"])).toEqual({ kind: "search", query: "ubuntu" });
    expect(parseCliArgs(["search", "example", "movie", "--category", "movies"])).toEqual({
      kind: "search",
      query: "example movie",
      category: "movies",
    });
    expect(parseCliArgs(["search", "--category", "games", "ubuntu"])).toEqual({
      kind: "search",
      query: "ubuntu",
      category: "games",
    });
  });
  it("rejects invalid headless searches", () => {
    expect(parseCliArgs(["search"])).toEqual({ kind: "invalid", arg: "search (missing query)" });
    expect(parseCliArgs(["search", "ubuntu", "--category", "books"])).toEqual({
      kind: "invalid",
      arg: "search (invalid category 'books')",
    });
    expect(parseCliArgs(["search", "ubuntu", "--limit", "10"])).toEqual({
      kind: "invalid",
      arg: "--limit",
    });
    expect(parseCliArgs(["search", "ubuntu", "--category"])).toEqual({
      kind: "invalid",
      arg: "--category (missing value)",
    });
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
  });
  it("rejects the removed --dir on watch with a hint", () => {
    expect(parseCliArgs(["watch", "/srv/blackhole", "--dir", "/mnt/media"])).toEqual({
      kind: "invalid",
      arg: "--dir",
      hint: "--dir is not a flag; use --to, or pass the folder to `torlnk files` positionally",
    });
  });
  it("rejects a second positional on watch", () => {
    expect(parseCliArgs(["watch", "/srv/blackhole", "/mnt/media"])).toEqual({
      kind: "invalid",
      arg: "/mnt/media",
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
      web: false,
      headless: false,
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
      web: false,
      headless: false,
    });
  });
  it("parses --headless on serve --web", () => {
    expect(parseCliArgs(["serve", "--web", "--headless"])).toMatchObject({
      kind: "serve",
      web: true,
      headless: true,
    });
  });
  it("rejects --headless without --web, naming why", () => {
    expect(parseCliArgs(["serve", "--headless"])).toEqual({
      kind: "invalid",
      arg: "--headless",
      hint: "--headless only means something with --web: it stops torlink opening a browser",
    });
  });
  it("rejects --headless outside serve", () => {
    expect(parseCliArgs(["--headless"])).toEqual({ kind: "invalid", arg: "--headless" });
    expect(parseCliArgs(["watch", "/tmp", "--headless"])).toEqual({
      kind: "invalid",
      arg: "--headless",
    });
    expect(parseCliArgs(["files", "--headless"])).toEqual({
      kind: "invalid",
      arg: "--headless",
    });
  });
  it("ignores a bad --port", () => {
    expect(parseCliArgs(["serve", "--port", "abc"]).kind).toBe("serve");
    expect((parseCliArgs(["serve", "--port", "abc"]) as { port?: number }).port).toBeUndefined();
  });
  it("enables the web UI on serve without a second port", () => {
    expect(parseCliArgs(["serve", "--web", "--port", "9999", "--host", "0.0.0.0"])).toMatchObject({
      kind: "serve",
      web: true,
      port: 9999,
      host: "0.0.0.0",
    });
  });
  it("rejects the removed --web-port on serve with a hint", () => {
    expect(parseCliArgs(["serve", "--web", "--web-port", "8080"])).toEqual({
      kind: "invalid",
      arg: "--web-port",
      hint: "--web-port is not a flag; the web ui binds --port",
    });
  });
  it("rejects the removed --web-host on serve with a hint", () => {
    expect(parseCliArgs(["serve", "--web", "--web-host", "0.0.0.0"])).toEqual({
      kind: "invalid",
      arg: "--web-host",
      hint: "--web-host is not a flag; the web ui binds --host",
    });
  });
  it("rejects a bareword on serve instead of ignoring it", () => {
    expect(parseCliArgs(["serve", "oops"])).toEqual({ kind: "invalid", arg: "oops" });
  });
  it("keeps --web out of serve's other flag values", () => {
    expect(parseCliArgs(["serve", "--web", "--to", "/mnt/media"])).toMatchObject({
      kind: "serve",
      web: true,
      downloadDir: "/mnt/media",
    });
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
  it("parses files flags with the folder as a positional", () => {
    expect(
      parseCliArgs([
        "files",
        "/mnt/media",
        "--port",
        "9160",
        "--host",
        "0.0.0.0",
        "--token",
        "s3cret",
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
  it("takes the folder positionally in any position", () => {
    expect(parseCliArgs(["files", "--port", "9160", "/mnt/media"])).toMatchObject({
      kind: "files",
      dir: "/mnt/media",
      port: 9160,
    });
  });
  it("rejects the removed --dir on files with a hint", () => {
    expect(parseCliArgs(["files", "--dir", "/mnt/media"])).toEqual({
      kind: "invalid",
      arg: "--dir",
      hint: "--dir is not a flag; use --to, or pass the folder to `torlnk files` positionally",
    });
  });
  it("rejects a second positional on files", () => {
    expect(parseCliArgs(["files", "/mnt/a", "/mnt/b"])).toEqual({
      kind: "invalid",
      arg: "/mnt/b",
    });
  });
});

describe("run flags", () => {
  it("enables the web UI alongside the TUI", () => {
    expect(parseCliArgs(["--web"])).toMatchObject({ kind: "run", web: true });
  });

  it("reads host, port and token for the TUI", () => {
    expect(
      parseCliArgs(["--web", "--host", "0.0.0.0", "--port", "8080", "--token", "s3cret"]),
    ).toMatchObject({
      kind: "run",
      web: true,
      host: "0.0.0.0",
      port: 8080,
      token: "s3cret",
    });
  });

  it("combines a magnet with --web in either order", () => {
    expect(parseCliArgs(["magnet:?xt=urn:btih:abc", "--web"])).toMatchObject({
      kind: "run",
      initialMagnet: "magnet:?xt=urn:btih:abc",
      web: true,
    });
    expect(parseCliArgs(["--web", "magnet:?xt=urn:btih:abc"])).toMatchObject({
      kind: "run",
      initialMagnet: "magnet:?xt=urn:btih:abc",
      web: true,
    });
  });

  it("combines a .torrent path and an infohash with the web flags", () => {
    expect(parseCliArgs(["./Foo.torrent", "--web", "--port", "8080"])).toMatchObject({
      kind: "run",
      initialTorrent: "./Foo.torrent",
      web: true,
      port: 8080,
    });
    const hash = "abcdef0123456789abcdef0123456789abcdef01";
    expect(parseCliArgs(["--host", "127.0.0.1", "--web", hash])).toMatchObject({
      kind: "run",
      initialMagnet: hash,
      web: true,
      host: "127.0.0.1",
    });
  });

  it("takes the flags without --web, so a mount site can still ignore them", () => {
    expect(parseCliArgs(["--port", "8080"])).toMatchObject({
      kind: "run",
      web: false,
      port: 8080,
    });
  });

  it("ignores a port that is not a positive number", () => {
    for (const bad of ["0", "-1", "nope"]) {
      expect(parseCliArgs(["--web", "--port", bad])).toMatchObject({ web: true, port: undefined });
    }
  });

  it("does not read a token from the environment (mount sites do that)", () => {
    const prev = process.env.TORLINK_API_TOKEN;
    process.env.TORLINK_API_TOKEN = "from-env";
    try {
      expect(parseCliArgs(["--web"])).toMatchObject({ kind: "run", web: true, token: undefined });
      expect(parseCliArgs(["serve", "--web"])).toMatchObject({ kind: "serve", token: undefined });
    } finally {
      if (prev === undefined) delete process.env.TORLINK_API_TOKEN;
      else process.env.TORLINK_API_TOKEN = prev;
    }
  });

  // --- strictness: never silently swallow an unknown flag ---

  it("still rejects an unknown flag that has a value after it", () => {
    expect(parseCliArgs(["--nope", "value"])).toEqual({ kind: "invalid", arg: "--nope" });
  });

  it("rejects a value flag with no value", () => {
    expect(parseCliArgs(["--web", "--port"])).toEqual({
      kind: "invalid",
      arg: "--port (missing value)",
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

  // --- removed spellings get a hint, not a bare "unknown argument" ---

  it("hints at --host when given the removed --web-host", () => {
    expect(parseCliArgs(["--web", "--web-host", "0.0.0.0"])).toEqual({
      kind: "invalid",
      arg: "--web-host",
      hint: "--web-host is not a flag; the web ui binds --host",
    });
  });

  it("hints at --port when given the removed --web-port", () => {
    expect(parseCliArgs(["--web", "--web-port", "8080"])).toEqual({
      kind: "invalid",
      arg: "--web-port",
      hint: "--web-port is not a flag; the web ui binds --port",
    });
  });

  it("hints at --token when given the removed --web-token", () => {
    expect(parseCliArgs(["--web", "--web-token", "s3cret"])).toEqual({
      kind: "invalid",
      arg: "--web-token",
      hint: "--web-token is not a flag; use --token",
    });
  });
});

describe("HELP_TEXT", () => {
  it("documents the web UI on both hosts", () => {
    expect(HELP_TEXT).toContain("torlnk --web");
    expect(HELP_TEXT).toContain("torlnk serve --web");
  });
  it("documents only the canonical flags", () => {
    expect(HELP_TEXT).toContain("--host <addr>");
    expect(HELP_TEXT).toContain("--port <n>");
    expect(HELP_TEXT).toContain("--token <secret>");
    expect(HELP_TEXT).toContain("--to <dir>");
  });
  it("does not mention the removed spellings", () => {
    for (const gone of ["--web-host", "--web-port", "--web-token", "--dir <dir>"]) {
      expect(HELP_TEXT).not.toContain(gone);
    }
  });
  it("shows the files folder as a positional", () => {
    expect(HELP_TEXT).toContain("torlnk files [dir]");
  });
});

describe("seed", () => {
  it("takes the path, and the flags the other headless modes take", () => {
    expect(parseCliArgs(["seed", "./album"])).toEqual({
      kind: "seed",
      path: "./album",
      seedTimeMs: undefined,
      deleteFiles: false,
      daemon: false,
    });
    expect(parseCliArgs(["seed", "--seed-time", "2h", "--daemon", "./album"])).toEqual({
      kind: "seed",
      path: "./album",
      seedTimeMs: 2 * 60 * 60 * 1000,
      deleteFiles: false,
      daemon: true,
    });
  });

  // Without a path there is nothing to hash, and defaulting to the cwd would
  // make a bare `torlnk seed` start hashing a home directory.
  it("is invalid with no path", () => {
    expect(parseCliArgs(["seed"])).toEqual({ kind: "invalid", arg: "seed (missing path)" });
  });
});
