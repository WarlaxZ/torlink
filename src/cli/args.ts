import { logFile } from "../config/paths";
import { isInfoHash } from "../sources/magnet";
import { parseDuration } from "../util/duration";

export type CliCommand =
  | { kind: "version" }
  | { kind: "help" }
  | {
      kind: "run";
      initialMagnet?: string;
      initialTorrent?: string;
      /** Host the browser dashboard in-process, sharing the TUI's queue. */
      web?: boolean;
      /** The interface, port and token the in-process dashboard binds. */
      host?: string;
      port?: number;
      token?: string;
    }
  | {
      kind: "watch";
      dir: string;
      downloadDir?: string;
      seedTimeMs?: number;
      deleteFiles?: boolean;
      daemon?: boolean;
    }
  | {
      kind: "serve";
      port?: number;
      host?: string;
      token?: string;
      downloadDir?: string;
      seedTimeMs?: number;
      deleteFiles?: boolean;
      daemon?: boolean;
      /**
       * Serve the browser dashboard instead of the bare JSON API. Same port,
       * same host, same token: the web server already routes the whole API
       * (web/routes.ts), so there is nothing for a second listener to add.
       */
      web?: boolean;
      /**
       * Do not open a browser on startup. Only meaningful with `--web`, which is
       * the only thing that has a browser to open.
       */
      headless?: boolean;
    }
  | { kind: "files"; port?: number; host?: string; token?: string; dir?: string; daemon?: boolean }
  | { kind: "attach" }
  | { kind: "update"; force?: boolean }
  | { kind: "import-netflix"; file: string }
  | { kind: "import-trakt" }
  | { kind: "invalid"; arg: string; hint?: string };

/**
 * Spellings that used to exist, mapped to the message that names their
 * replacement. A removed flag must never read as a typo: the whole point of
 * dropping `--web-host` was that it used to be *accepted and ignored*, so the
 * one thing the error has to do is say where the setting went.
 */
const REMOVED_FLAGS: Record<string, string> = {
  "web-host": "--web-host is not a flag; the web ui binds --host",
  "web-port": "--web-port is not a flag; the web ui binds --port",
  "web-token": "--web-token is not a flag; use --token",
  dir: "--dir is not a flag; use --to, or pass the folder to `torlnk files` positionally",
};

/** What one subcommand accepts: `--flag value` pairs, and valueless booleans. */
interface FlagSpec {
  values: readonly string[];
  bools: readonly string[];
}

type Scan =
  | { ok: true; flags: Record<string, string>; bools: Set<string>; rest: string[] }
  | { ok: false; error: CliCommand };

/**
 * The one argument reader every command uses. Strict by construction: a `--`
 * token outside the command's own spec is an error, never a value quietly
 * eaten off the next argument. That silent swallow is exactly how
 * `serve --web-host 0.0.0.0` came to bind loopback and say nothing.
 */
function scanFlags(args: string[], spec: FlagSpec): Scan {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (spec.bools.includes(name)) {
      bools.add(name);
      continue;
    }
    if (spec.values.includes(name)) {
      const value = args[++i];
      if (value === undefined) {
        return { ok: false, error: { kind: "invalid", arg: `${arg} (missing value)` } };
      }
      flags[name] = value;
      continue;
    }
    const hint = REMOVED_FLAGS[name];
    return { ok: false, error: hint ? { kind: "invalid", arg, hint } : { kind: "invalid", arg } };
  }
  return { ok: true, flags, bools, rest };
}

const RUN_FLAGS: FlagSpec = { values: ["host", "port", "token"], bools: ["web"] };
const WATCH_FLAGS: FlagSpec = {
  values: ["to", "seed-time"],
  bools: ["delete-files", "daemon"],
};
const SERVE_FLAGS: FlagSpec = {
  values: ["port", "host", "token", "to", "seed-time"],
  bools: ["delete-files", "daemon", "web", "headless"],
};
const FILES_FLAGS: FlagSpec = { values: ["port", "host", "token"], bools: ["daemon"] };

function parsePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function seedTimeFrom(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  return parseDuration(raw) ?? undefined;
}

export function parseCliArgs(argv: string[]): CliCommand {
  const args = argv.filter((a) => a.trim() !== "");
  // No arguments: the plain TUI. Routed through parseRun so the "run" shape has
  // exactly one producer — a hand-written `{ kind: "run" }` here would drift
  // from it the moment another field is added, leaving `web` undefined on the
  // commonest invocation of all.
  if (args.length === 0) return parseRun([]);
  const a = args[0]!;
  if (a === "--version" || a === "-v") return { kind: "version" };
  if (a === "--help" || a === "-h") return { kind: "help" };
  if (a === "attach") return { kind: "attach" };
  if (a === "update") return { kind: "update", force: args.slice(1).includes("--force") };
  if (a === "import-netflix") {
    const file = args[1];
    if (!file) return { kind: "invalid", arg: "import-netflix (missing file)" };
    return { kind: "import-netflix", file };
  }
  if (a === "import-trakt") return { kind: "import-trakt" };
  if (a === "watch") {
    const scan = scanFlags(args.slice(1), WATCH_FLAGS);
    if (!scan.ok) return scan.error;
    const dir = scan.rest[0];
    if (!dir) return { kind: "invalid", arg: "watch (missing directory)" };
    // The folder to watch is the one positional this command takes; a second
    // one is a `--to` the user forgot to name, not a second watch folder.
    if (scan.rest.length > 1) return { kind: "invalid", arg: scan.rest[1]! };
    return {
      kind: "watch",
      dir,
      downloadDir: scan.flags.to,
      seedTimeMs: seedTimeFrom(scan.flags["seed-time"]),
      deleteFiles: scan.bools.has("delete-files"),
      daemon: scan.bools.has("daemon"),
    };
  }
  if (a === "serve") {
    const scan = scanFlags(args.slice(1), SERVE_FLAGS);
    if (!scan.ok) return scan.error;
    if (scan.rest.length > 0) return { kind: "invalid", arg: scan.rest[0]! };
    // Strict, like every other flag on this command: `--headless` with no --web
    // turns nothing off, and accepting it silently is how `--web-host` came to
    // be a flag that did nothing. (The TUI warns instead of erroring for its
    // orphans, in App.tsx — a TUI cannot exit with a message anyone would read.)
    if (scan.bools.has("headless") && !scan.bools.has("web")) {
      return {
        kind: "invalid",
        arg: "--headless",
        hint: "--headless only means something with --web: it stops torlink opening a browser",
      };
    }
    return {
      kind: "serve",
      port: parsePort(scan.flags.port),
      host: scan.flags.host,
      token: scan.flags.token,
      downloadDir: scan.flags.to,
      seedTimeMs: seedTimeFrom(scan.flags["seed-time"]),
      deleteFiles: scan.bools.has("delete-files"),
      daemon: scan.bools.has("daemon"),
      web: scan.bools.has("web"),
      headless: scan.bools.has("headless"),
    };
  }
  if (a === "files") {
    const scan = scanFlags(args.slice(1), FILES_FLAGS);
    if (!scan.ok) return scan.error;
    // Positional, like `watch <dir>`: across the CLI a bare directory is always
    // the folder the command operates on, and --to is always where output goes.
    if (scan.rest.length > 1) return { kind: "invalid", arg: scan.rest[1]! };
    return {
      kind: "files",
      port: parsePort(scan.flags.port),
      host: scan.flags.host,
      token: scan.flags.token,
      dir: scan.rest[0],
      daemon: scan.bools.has("daemon"),
    };
  }
  return parseRun(args);
}

/**
 * The bare invocation: an optional magnet / info hash / .torrent path, plus the
 * web-UI flags, in any order. Order-independence is deliberate — `torlnk
 * "magnet:?..." --web` and `torlnk --web "magnet:?..."` both read naturally, and
 * accepting only one of them would mean silently dropping either the flag or the
 * download in the other.
 */
function parseRun(args: string[]): CliCommand {
  const scan = scanFlags(args, RUN_FLAGS);
  if (!scan.ok) return scan.error;

  let target: string | undefined;
  for (const arg of scan.rest) {
    if (target === undefined && isRunTarget(arg)) target = arg;
    else return { kind: "invalid", arg };
  }

  const isTorrent = target !== undefined && /\.torrent$/i.test(target);
  return {
    kind: "run",
    initialMagnet: isTorrent ? undefined : target,
    initialTorrent: isTorrent ? target : undefined,
    web: scan.bools.has("web"),
    host: scan.flags.host,
    port: parsePort(scan.flags.port),
    token: scan.flags.token,
  };
}

function isRunTarget(arg: string): boolean {
  return /^magnet:\?/i.test(arg) || isInfoHash(arg) || /\.torrent$/i.test(arg);
}

export const HELP_TEXT = `torlink, terminal-native torrent search

usage
  torlnk                      open the search TUI
  torlnk "magnet:?xt=..."     start a download on launch
  torlnk path/to/file.torrent open a .torrent file on launch
  torlnk --web                open the TUI and serve the browser UI on :9162
  torlnk watch <dir>          no TUI: download torrents dropped into <dir>
  torlnk serve                no TUI: HTTP add API (POST /add) on :9161
  torlnk serve --web          no TUI: the add API plus the browser UI on :9161
  torlnk files [dir]          no TUI: serve downloads over HTTP on :9160
  torlnk attach               open/reattach the TUI in a persistent tmux session
  torlnk update [--force]     update to the latest release and restart any daemon
                              (--force rebuilds/restarts even if already current)
  torlnk import-netflix <csv>  send a Netflix "viewing activity" CSV to reccd
  torlnk import-trakt          connect Trakt and import your history into reccd
  torlnk --version            print the version

once open: type to search every source at once, enter to run, arrows to move,
d to download, ? for keys
tip: quote magnet links (they contain & characters)

flags, one name per thing
  --host <addr>    the interface this process binds (default 127.0.0.1)
  --port <n>       the port it binds (serve 9161, files 9160, --web 9162)
  --token <secret> the shared secret; required to bind anything but loopback
                   (serve --web mints one for you instead of refusing)
  --to <dir>       where downloads land (watch, serve)
A bare directory argument is always the folder a command operates on
(watch <dir>, files [dir]); --to is always where output goes.

watch mode (no TUI): drop a .torrent, or a .magnet/.txt holding a magnet or
info hash, into <dir> and it downloads then seeds. Add --to <dir> to choose
where files land. Handled files move to <dir>/.processed (or /.failed).

seed mode (watch/serve): --seed-time <dur> stops seeding a torrent that long
after it finishes (e.g. 1h, 30m, 90s, 2d); files are kept by default. Add
--delete-files to also remove the downloaded data when the timer expires.

--daemon (watch/serve/files): background the process (own session, logs to a
file), so you can log out and it keeps running. Prints the pid and log path.

torlnk attach: run the TUI inside a persistent tmux session. Detach with
tmux's ctrl-b d, log out, then torlnk attach again to reattach where you
left off. Downloads and seeds keep running while detached.

serve mode (no TUI): a small HTTP API for handing torlink a magnet.
  POST /add {"magnet":"..."}   queue a magnet or info hash
  GET  /downloads              list active downloads and seeds
  GET  /health                 liveness (no auth)
flags: --port <n> (default 9161), --host <addr>, --token <secret> (required
to bind a public --host; or TORLINK_API_TOKEN), --to <dir> (where files land).

web ui (--web): search, posters, streaming, the queue and For You in a
browser, over the same queue as the process hosting it.
  torlnk --web             the TUI hosts it; quitting the TUI stops it
  torlnk serve --web       the daemon hosts it, on serve's own port
It binds --host and --port like everything else — under serve there is one
server, not two: the dashboard's port also answers /add, /downloads and
/control.
serve --web opens your browser on the link it prints, and mints a token for
you when --host is not loopback (pass --token to pin one across restarts).
--headless prints the link and opens nothing; so does --daemon, and so does
a stdout that is not a terminal. In the TUI, shift+w opens the dashboard.

files mode (no TUI): a read-only, range-aware HTTP server over the downloads
folder, so finished files stream to a browser or media player.
  GET /            list the folder (JSON)
  GET /<path>      stream a file (supports Range for seeking/resuming)
flags: --port <n> (default 9160), --host <addr>, --token <secret> (required
to bind a public --host; or TORLINK_FILES_TOKEN). Pass the folder to serve as
a positional argument; it defaults to your downloads folder.

logs: ${logFile}
`;
