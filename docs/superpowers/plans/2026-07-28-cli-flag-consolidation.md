# CLI Flag Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the CLI to one canonical flag per concept (`--host`, `--port`, `--token`, `--to`), serve the browser UI on the same port as the API, and make unknown flags hard errors instead of silent no-ops.

**Architecture:** One `scanFlags(args, spec)` helper replaces `splitBooleans` / `readFlags` / `RUN_VALUE_FLAGS` in `src/cli/args.ts`; every subcommand declares its own value/boolean flag spec and anything outside that spec is `{ kind: "invalid" }`. Removed spellings (`--web-host`, `--web-port`, `--web-token`, `--dir`) carry a per-flag hint through a new optional `hint` field on the invalid command. In `src/daemon/serve.ts`, `--web` stops starting a second listener: the web server already routes the whole daemon API (`src/web/routes.ts:1105`), so under `--web` it binds `--port` and is the only server.

**Tech Stack:** TypeScript, Node 22, vitest, ink (TUI), node:http.

**Spec:** `docs/superpowers/specs/2026-07-28-cli-flag-consolidation-design.md`

**Commands:** `npm test` (vitest run), `npx vitest run <path>` for one file, `npm run typecheck`, `npm run lint`, `npm run build`.

**One intentional deviation from the spec's "Affected code" list:** the `App` component keeps its `webPort` / `webHost` / `webToken` prop names. They are internal props naming *the web mount* inside a component with many other concerns, so bare `host`/`port`/`token` would read as less clear, not more. Only the CLI surface and the user-facing warning strings change. `src/daemon/files.ts` also needs no change — its `FilesOptions.dir` stays; only where that value comes from changes.

---

### Task 1: Strict flag scanner and the `run` branch

**Files:**
- Modify: `src/cli/args.ts:5-78` (types, `splitBooleans`, `readFlags`), `src/cli/args.ts:159-200` (`RUN_VALUE_FLAGS`, `parseRun`)
- Test: `src/cli/args.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the whole `describe("web flags", ...)` block (`src/cli/args.test.ts:195-387`) with:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/cli/args.test.ts`
Expected: FAIL — `--web-host` still parses into `webHost`, `--port` is not a run flag, no `hint` field exists.

- [ ] **Step 3: Replace the parsing machinery**

In `src/cli/args.ts`, change the `run` and `invalid` members of `CliCommand` (`src/cli/args.ts:8-17` and `:48`) to:

```ts
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
```

```ts
  | { kind: "invalid"; arg: string; hint?: string };
```

Delete `BOOL_FLAGS`, `splitBooleans` and `readFlags` (`src/cli/args.ts:50-78`) and put this in their place:

```ts
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
  bools: ["delete-files", "daemon", "web"],
};
const FILES_FLAGS: FlagSpec = { values: ["port", "host", "token"], bools: ["daemon"] };
```

Delete `RUN_VALUE_FLAGS` and its comment (`src/cli/args.ts:155-159`) and replace `parseRun` with:

```ts
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
```

The `watch`, `serve` and `files` branches still call the deleted helpers at this point, so the file will not compile until they are converted. Convert all three now by pasting in the final branch bodies from Task 2 Step 3, Task 3 Step 3 (including the `CliCommand` change that drops `webPort`) and Task 4 Step 3. Their tests arrive in those tasks; this step only keeps the tree building.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/cli/args.test.ts && npm run typecheck`
Expected: the `run flags` block passes. Tests in the first `describe` that still use `--dir` (`src/cli/args.test.ts:79-87`, `:170-192`) fail — Tasks 2 and 4 rewrite them.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/args.test.ts
git commit -m "refactor(cli): strict per-command flag scanner; --host/--port/--token on the TUI"
```

---

### Task 2: `watch` — `--to` only

**Files:**
- Modify: `src/cli/args.ts` (the `watch` branch)
- Test: `src/cli/args.test.ts:70-87`

- [ ] **Step 1: Write the failing test**

Replace the `"parses watch with a --to download dir"` test (`src/cli/args.test.ts:70-87`) with:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/cli/args.test.ts -t watch`
Expected: FAIL — `--dir` still parses as a download dir.

- [ ] **Step 3: Rewrite the `watch` branch**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/cli/args.test.ts -t watch`
Expected: PASS (all `watch` tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/args.test.ts
git commit -m "refactor(cli): watch takes --to only, rejects --dir with a hint"
```

---

### Task 3: `serve` — no `--web-port`, no `--dir`, no stray barewords

**Files:**
- Modify: `src/cli/args.ts` (the `serve` branch)
- Test: `src/cli/args.test.ts:116-158`

- [ ] **Step 1: Write the failing tests**

Add to the first `describe` block, after `"ignores a bad --port"` (`src/cli/args.test.ts:159`):

```ts
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
```

Also add `web: false` to the expected object in `"parses serve flags"` (`src/cli/args.test.ts:144-154`) if it is not already there — it is, at `:153`. No change needed to `"parses serve with defaults"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/cli/args.test.ts -t serve`
Expected: FAIL — `--web-port` parses into `webPort`, `serve oops` is silently ignored.

- [ ] **Step 3: Rewrite the `serve` branch**

Change the `serve` member of `CliCommand` (`src/cli/args.ts:26-42`) to drop `webPort` and re-word the `web` comment:

```ts
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
    }
```

And the branch:

```ts
  if (a === "serve") {
    const scan = scanFlags(args.slice(1), SERVE_FLAGS);
    if (!scan.ok) return scan.error;
    if (scan.rest.length > 0) return { kind: "invalid", arg: scan.rest[0]! };
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
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/cli/args.test.ts -t serve && npm run typecheck`
Expected: the `serve` tests pass. `typecheck` fails in `src/index.tsx` (`cmd.webPort` no longer exists) — Task 8 fixes it.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/args.test.ts
git commit -m "refactor(cli): serve drops --web-port/--dir and rejects unknown args"
```

---

### Task 4: `files` — folder as a positional

**Files:**
- Modify: `src/cli/args.ts` (the `files` branch)
- Test: `src/cli/args.test.ts:160-192`

- [ ] **Step 1: Write the failing tests**

Replace the `"parses files flags"` test (`src/cli/args.test.ts:170-192`) with:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/cli/args.test.ts -t files`
Expected: FAIL — the positional lands nowhere and `--dir` still parses.

- [ ] **Step 3: Rewrite the `files` branch**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/cli/args.test.ts`
Expected: PASS for every test except the `HELP_TEXT` block (Task 6).

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/args.test.ts
git commit -m "refactor(cli): files takes its folder positionally"
```

---

### Task 5: Surface the hint at the top level

**Files:**
- Modify: `src/index.tsx:21-25`

- [ ] **Step 1: Write the failing test**

There is no test harness for `src/index.tsx` (it is the entry module and runs on import). Verify by hand in Step 4 instead — do not invent a harness for four lines.

- [ ] **Step 2: Read the current code**

`src/index.tsx:21-25` is:

```ts
if (cmd.kind === "invalid") {
  console.error(`error: unknown argument '${cmd.arg}'\n`);
  console.error(HELP_TEXT);
  process.exit(1);
}
```

- [ ] **Step 3: Print the hint when there is one**

```ts
if (cmd.kind === "invalid") {
  // A removed flag gets its replacement named. "unknown argument '--web-host'"
  // is true but useless — the user is looking for the setting, not the spelling.
  console.error(`error: ${cmd.hint ?? `unknown argument '${cmd.arg}'`}\n`);
  console.error(HELP_TEXT);
  process.exit(1);
}
```

- [ ] **Step 4: Verify by hand**

Run: `npx tsx src/index.tsx serve --web --web-host 0.0.0.0; echo "exit=$?"`
Expected: first line `error: --web-host is not a flag; the web ui binds --host`, then the help text, then `exit=1`.

Run: `npx tsx src/index.tsx --nope; echo "exit=$?"`
Expected: `error: unknown argument '--nope'`, then help, then `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add src/index.tsx
git commit -m "feat(cli): name the replacement flag when a removed one is passed"
```

---

### Task 6: Rewrite `HELP_TEXT`

**Files:**
- Modify: `src/cli/args.ts` (`HELP_TEXT`, from `usage` through the `files mode` block)
- Test: `src/cli/args.test.ts:389-396`

- [ ] **Step 1: Write the failing test**

Replace the `HELP_TEXT` describe block (`src/cli/args.test.ts:389-396`) with:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/cli/args.test.ts -t HELP_TEXT`
Expected: FAIL — the help still documents `--web-port` and `--web-host`.

- [ ] **Step 3: Rewrite the help text**

In `src/cli/args.ts`, replace the `usage` line for `files`, and the `serve mode`, `web ui`, and `files mode` blocks, so the whole `HELP_TEXT` reads:

```ts
export const HELP_TEXT = `torlink, terminal-native torrent search

usage
  torlnk                      open the search TUI
  torlnk "magnet:?xt=..."     start a download on launch
  torlnk path/to/file.torrent open a .torrent file on launch
  torlnk --web                open the TUI and serve the browser UI on :9162
  torlnk watch <dir>          headless: download torrents dropped into <dir>
  torlnk serve                headless: HTTP add API (POST /add) on :9161
  torlnk serve --web          headless: the add API plus the browser UI on :9161
  torlnk files [dir]          headless: serve downloads over HTTP on :9160
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
/control. A non-loopback host is refused without a token.

files mode (no TUI): a read-only, range-aware HTTP server over the downloads
folder, so finished files stream to a browser or media player.
  GET /            list the folder (JSON)
  GET /<path>      stream a file (supports Range for seeking/resuming)
flags: --port <n> (default 9160), --host <addr>, --token <secret> (required
to bind a public --host; or TORLINK_FILES_TOKEN). Pass the folder to serve as
a positional argument; it defaults to your downloads folder.

logs: ${logFile}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/cli/args.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/args.test.ts
git commit -m "docs(cli): rewrite --help for the consolidated flag set"
```

---

### Task 7: One listener under `serve --web`

**Files:**
- Modify: `src/daemon/serve.ts:29-42` (`ServeOptions`), `:280-345` (guards and the web mount), `:346-412` (the API server), `:425-440` (shutdown)
- Test: `src/daemon/shutdown.test.ts:103-205`

- [ ] **Step 1: Write the failing tests**

In `src/daemon/shutdown.test.ts`, replace the first five tests of `describe("runServe web mount", ...)` — `"serves the api and mounts the web ui on the api port + 1"` (`:139`), `"uses --web-port when one is given"` (`:161`), `"does not mount the web ui without --web"` (`:173`), `"warns when --web-port is set without --web"` (`:189`), and `"refuses to start when the web port equals the api port"` (`:199`) — with:

```ts
  it("serves the api and the web ui on one port", async () => {
    const port = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, web: true, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);

    // One port answers both surfaces: the daemon API's bare paths and the
    // dashboard's /api/*. That is the whole point of dropping --web-port.
    const api = await fetch(`http://127.0.0.1:${port}/health`);
    expect(api.status).toBe(200);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ downloads: [], seeds: [] });
    const downloads = await fetch(`http://127.0.0.1:${port}/downloads`);
    expect(downloads.status).toBe(200);

    // Nothing on the port the old build derived for the dashboard.
    expect(await isListening(port + 1)).toBe(false);

    newSignalHandler(before)();
    await done;
  });

  it("serves only the api without --web", async () => {
    const port = await freePortPair();
    const before = new Set(process.listeners("SIGTERM"));
    const done = runServe({ port, downloadDir: dir });
    expect(await waitUntil(() => isListening(port))).toBe(true);
    const api = await fetch(`http://127.0.0.1:${port}/health`);
    expect(api.status).toBe(200);
    // The dashboard's own routes are not mounted, and no second port is bound.
    const ui = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(ui.status).toBe(404);
    expect(await isListening(port + 1)).toBe(false);
    newSignalHandler(before)();
    await done;
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/daemon/shutdown.test.ts`
Expected: FAIL — `/api/status` on the API port 404s, and `port + 1` is listening.

- [ ] **Step 3: Collapse the two servers into one**

In `src/daemon/serve.ts`, drop `webPort` from `ServeOptions` and re-word the `web` doc comment:

```ts
  /**
   * Serve the browser UI. It binds this same host and port: the web server
   * already routes the entire daemon API (see web/routes.ts, which delegates
   * every non-/api/ path to handleApi), so a second listener would only be a
   * second copy of the same surface on a port nobody asked for.
   */
  web?: boolean;
```

Delete the `--web-port ignored without --web` warning block and the `webPort === port` collision check (`src/daemon/serve.ts:293-312`) entirely — neither flag exists any more.

Replace the web-mount block (`src/daemon/serve.ts:319-343`) with:

```ts
  // With --web there is one server, not two. It binds the port the user chose,
  // and answers both the dashboard and the add API — one process, one address,
  // one exposure decision.
  let web: WebServerHandle | null = null;
  if (options.web) {
    try {
      web = await startWebServer(runtime, {
        port,
        host,
        ...(token ? { token } : {}),
        log,
      });
    } catch (e) {
      // A startup failure, not a degraded mode: coming up with the dashboard
      // silently missing is worse than not coming up at all.
      await failStartup(
        `error: could not start the web ui on port ${port}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
        null,
      );
      return;
    }
    log(`listening on http://${host}:${port}  (api + web ui, downloads -> ${runtime.downloadDir})`);
    log(token ? "auth: token required" : "auth: none (loopback only)");
  }
```

Wrap the bare API server so it only exists without `--web`. Change `const server = http.createServer((req, res) => {` (`src/daemon/serve.ts:346`) to:

```ts
  const server = options.web ? null : http.createServer((req, res) => {
```

Wrap the listen block (`src/daemon/serve.ts:397-412`) in a guard:

```ts
  if (server) {
    const listenErr = await new Promise<Error | null>((resolve) => {
      const onError = (err: Error): void => resolve(err);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        log(`listening on http://${host}:${port}  (downloads -> ${runtime.downloadDir})`);
        log(token ? "auth: token required" : "auth: none (loopback only)");
        resolve(null);
      });
    });
    if (listenErr) {
      await failStartup(`error: could not start the api on port ${port}: ${listenErr.message}`, web);
      return;
    }
  }
```

And in the shutdown sequence, guard the API close (`src/daemon/serve.ts:425-440`):

```ts
        if (server) {
          await new Promise<void>((done) => {
            server.close(() => done());
            // The same fix web/server.ts documents for the web server, and for
            // the same reason: close() stops accepting and then waits for open
            // connections to end, and a socket that is connected with no
            // *complete* request in flight — a browser preconnect, a TCP health
            // probe, a port scan, half-sent headers — never ends. One bare
            // `net.connect` used to make Ctrl-C hang here forever, which is also
            // what made `daemon/restart.ts` give up after 10s and report
            // stillRunning: true, leaving `torlnk update` with the old daemon
            // still alive.
            server.closeAllConnections();
          });
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/daemon/shutdown.test.ts src/daemon/serve.test.ts`
Expected: PASS. Every remaining shutdown test that passes `web: true` now exercises the single-listener path unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/serve.ts src/daemon/shutdown.test.ts
git commit -m "feat(serve): --web serves the api and the dashboard on one port"
```

---

### Task 8: Wire the new command shapes at the entry point

**Files:**
- Modify: `src/index.tsx:58-78` (serve/files options), `:127-145` (App props)

- [ ] **Step 1: Confirm the type errors that stand in for a test**

Run: `npm run typecheck`
Expected: FAIL — `cmd.webPort`, `cmd.webHost`, `cmd.webToken` no longer exist on the parsed commands.

- [ ] **Step 2: Update the `serve` options**

```ts
} else if (cmd.kind === "serve") {
  if (cmd.daemon) daemonize("serve");
  const options = {
    port: cmd.port,
    host: cmd.host,
    token: cmd.token ?? process.env.TORLINK_API_TOKEN,
    downloadDir: cmd.downloadDir,
    seedTimeMs: cmd.seedTimeMs,
    deleteFiles: cmd.deleteFiles,
    web: cmd.web,
  };
  void import("./daemon/serve").then(({ runServe }) => runServe(options).catch(failHeadless));
```

The `files` branch (`src/index.tsx:69-78`) needs no change: `cmd.dir` still holds the folder, it just arrives positionally now.

- [ ] **Step 3: Update the App props**

```tsx
    web={cmd.web}
    webPort={cmd.port}
    webHost={cmd.host}
    // parseCliArgs is pure and never reads the environment, so the env fallback
    // the daemon paths apply above has to be applied here too — otherwise
    // `torlnk --web --host 0.0.0.0` with only TORLINK_API_TOKEN set is refused
    // for a missing token the user did supply.
    //
    // Only on the --web path: merging it unconditionally would turn a
    // TORLINK_API_TOKEN exported for the daemon into a phantom --token and make
    // App warn about a flag nobody passed.
    webToken={cmd.web ? (cmd.token ?? process.env.TORLINK_API_TOKEN) : cmd.token}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/index.tsx
git commit -m "refactor(cli): wire the consolidated flags through the entry point"
```

---

### Task 9: The TUI's orphan-flag warning names the new flags

**Files:**
- Modify: `src/ui/App.tsx:533-546`
- Test: `src/ui/App.web.test.tsx:295-311`

- [ ] **Step 1: Write the failing test**

Replace the `"does not start anything without --web, and warns about orphaned flags"` test (`src/ui/App.web.test.tsx:295-311`) with:

```ts
  it("does not start anything without --web, and warns about orphaned flags", async () => {
    const start = vi.fn(async () => makeHandle());
    const ui = renderUI(<App webPort={19002} startWebServerImpl={start} />);
    try {
      await vi.waitFor(() =>
        expect(logSpies.warn).toHaveBeenCalledWith("[web] --port ignored without --web"),
      );
      expect(start).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(ui.frame()).toContain("Search"));
      ui.press(TAB);
      await vi.waitFor(() => expect(ui.frame()).toContain("--port ignored without --web"));
      expectNothingOnStdout();
    } finally {
      ui.unmount();
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/App.web.test.tsx -t orphaned`
Expected: FAIL — the warning still says `--web-port`.

- [ ] **Step 3: Rename the flags in the warning**

In `src/ui/App.tsx`, replace the orphan-flag effect (`src/ui/App.tsx:533-546`):

```tsx
  // `--port 8080` without `--web` parses fine and does nothing. Say so rather
  // than silently accepting a flag the user believes turned something on.
  useEffect(() => {
    if (web) return;
    const orphans = [
      webPort !== undefined ? "--port" : null,
      webHost ? "--host" : null,
      webToken ? "--token" : null,
    ].filter((f): f is string => f !== null);
    if (orphans.length === 0) return;
    log.warn(`[web] ${orphans.join(", ")} ignored without --web`);
    setNotice(`${orphans.join(", ")} ignored without --web`);
  }, [web, webPort, webHost, webToken]);
```

The props keep their names: they configure the web mount, and inside this component `port`/`host`/`token` would be ambiguous. Only the user-facing strings change.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/App.web.test.tsx`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add src/ui/App.tsx src/ui/App.web.test.tsx
git commit -m "fix(tui): orphan-flag warning names the canonical flags"
```

---

### Task 10: README

**Files:**
- Modify: `README.md:184-215` (the browser section), `README.md:284` (the headless summary)

- [ ] **Step 1: Replace the "In your browser" opening**

`README.md:191` currently reads:

> Either way it lands on **`http://127.0.0.1:9162`**, and `torlnk --web` prints the address on the splash. Change it with `--web-port`. Under `serve`, the UI port is derived from the API port + 1 (so `serve --port 8080 --web` puts the API on 8080 and the UI on 8081) unless you pass `--web-port` yourself.

Replace it with:

```markdown
`torlnk --web` lands on **`http://127.0.0.1:9162`** and prints the address on the splash; `torlnk serve --web` lands on serve's own port, **`http://127.0.0.1:9161`**. Change either with `--port`. Under `serve` there's one server, not two: the same port answers the dashboard *and* `/add`, `/downloads` and `/control`, so there's one address to remember and one thing to firewall.
```

- [ ] **Step 2: Replace the "Reaching it from another device" block**

`README.md:198-215` (from the code fence through the paragraph ending "doesn't quietly become a password on your interactive session.") becomes:

````markdown
```sh
torlnk --web --host 0.0.0.0 --token "$(openssl rand -hex 16)"
torlnk serve --web --host 0.0.0.0 --token "$(openssl rand -hex 16)"
```

Both commands read the same three flags — `--host`, `--port`, `--token` — because both are one process making one exposure decision.

#### Setting the token

Two ways, in the order torlink prefers them:

| | |
|---|---|
| `--token <secret>` | The flag. Works on `--web`, `serve` and `files` alike. |
| `TORLINK_API_TOKEN` | Environment. Keeps the secret out of your shell history and out of `ps`, which is what you want on a shared box. Used by `serve` and by `torlnk --web`; `files` reads `TORLINK_FILES_TOKEN`. |

The flag beats the environment variable. The environment variable is only consulted when you actually pass `--web`, so a `TORLINK_API_TOKEN` you exported for the daemon doesn't quietly become a password on your interactive session.
````

- [ ] **Step 3: Update the headless summary**

`README.md:279` lists `torlnk files          stream finished downloads over HTTP`. Change that line to:

```
    torlnk files [dir]    stream finished downloads over HTTP
```

And `README.md:284` currently ends "...or `--web` to `serve` for the [browser dashboard](#in-your-browser-optional) alongside the add API". Change that clause to:

```markdown
or `--web` to `serve` for the [browser dashboard](#in-your-browser-optional) on the same port as the add API
```

- [ ] **Step 4: Verify no stale flag names remain**

Run: `grep -n -- "--web-port\|--web-host\|--web-token\|--dir" README.md src/ docs/superpowers/plans/ --include="*.ts" --include="*.tsx" --include="*.md" -r`
Expected: matches only in `docs/superpowers/specs/2026-07-28-cli-flag-consolidation-design.md`, this plan, and the `REMOVED_FLAGS` table plus its tests. No matches in `README.md` outside the removal context, none in `HELP_TEXT`.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: README follows the consolidated flag set"
```

---

### Task 11: Full verification

**Files:** none — this task only runs things.

- [ ] **Step 1: The whole suite**

Run: `npm test`
Expected: all files pass. If `src/web/server.test.ts:126` (`"binds a public host when a token is set"`) still has a comment mentioning `--web-host`, reword it to `--host` — it is a comment, not a behaviour.

- [ ] **Step 2: Types and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean, no output.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `ESM ⚡️ Build success` twice, then `postbuild: wrote dist/cli.cjs ...`.

- [ ] **Step 4: The original bug, end to end**

Run: `node dist/index.js serve --web --host 0.0.0.0 --token a`
Expected, within a second or two:

```
[torlnk serve] ... web ui on http://0.0.0.0:9161 (token required)
[torlnk serve] ... listening on http://0.0.0.0:9161  (api + web ui, downloads -> ...)
[torlnk serve] ... auth: token required
```

No `9162` anywhere. In another shell:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9161/health          # 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer a' \
  http://127.0.0.1:9161/api/status                                             # 200
```

Then Ctrl-C and confirm the process exits rather than hanging.

- [ ] **Step 5: The removed flags**

```bash
node dist/index.js serve --web --web-host 0.0.0.0; echo "exit=$?"   # hint + exit=1
node dist/index.js serve --web --web-port 8080;    echo "exit=$?"   # hint + exit=1
node dist/index.js watch /tmp --dir /tmp/out;      echo "exit=$?"   # hint + exit=1
node dist/index.js files --dir /tmp;               echo "exit=$?"   # hint + exit=1
```

Expected: each prints `error: --<flag> is not a flag; ...` followed by the help, and exits 1.

- [ ] **Step 6: `files` positional**

Run: `node dist/index.js files /tmp` then `curl -s http://127.0.0.1:9160/ | head -c 200`
Expected: a JSON listing of `/tmp`. Ctrl-C to stop.

- [ ] **Step 7: Commit anything the verification turned up**

```bash
git add -A
git commit -m "chore: verification fixes for the flag consolidation"
```

(Skip if the tree is clean.)

---

## Coverage against the spec

| Spec requirement | Task |
|---|---|
| `--host` / `--port` / `--token` / `--to` canonical | 1, 2, 3, 4 |
| `--web-host`, `--web-port`, `--web-token`, `--dir` removed | 1, 2, 3, 4 |
| Per-flag hints on removed spellings | 1, 5 |
| Unknown flags are hard errors on watch/serve/files | 1, 2, 3, 4 |
| `files` folder positional | 4 |
| One port per process under `serve --web` | 7 |
| Defaults 9161 / 9160 / 9162 unchanged | 6 (documented), 7 (serve), unchanged elsewhere |
| URL paths unchanged | not touched by any task, asserted in 7 |
| Env var names unchanged | not touched by any task |
| `--help` matches reality | 6 |
| `README.md` matches reality | 10 |
| Success criteria | 11 |
