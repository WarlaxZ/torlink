// The daemon's log file holds credentials now, so its mode is a security
// property rather than a detail.
//
// `serve --web` mints a token when asked to bind a non-loopback host without
// one, and prints it on stdout — which under `--daemon` *is* this file. Before
// that, the log was created with the process default (0644 on a normal umask)
// and held nothing worth reading; every install from before this change still
// has one at that mode, which is why spawnDaemon tightens on every spawn and
// not only at creation.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnDaemon, logPathFor, runPathFor, pidPathFor } from "./daemonize";

const NAME = "test-daemonize";

function cleanup(): void {
  // Every path spawnDaemon writes lives under this worker's own
  // TORLINK_STATE_DIR (see src/test-setup.ts), so removing them cannot touch a
  // developer's real daemon state.
  for (const p of [logPathFor(NAME), runPathFor(NAME), pidPathFor(NAME)]) {
    fs.rmSync(p, { force: true });
  }
}

describe("spawnDaemon", () => {
  afterEach(() => cleanup());

  it("creates the log file readable only by its owner", () => {
    cleanup();
    // `node -e ""` is a real child that exits immediately: enough to make
    // spawnDaemon open the log and hand it over as stdio, without leaving a
    // process behind for the rest of the suite to trip over.
    const pid = spawnDaemon(NAME, ["-e", ""], process.cwd());
    expect(pid).toBeGreaterThan(0);

    const mode = fs.statSync(logPathFor(NAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keeps the run descriptor owner-only, because it stores the argv", () => {
    // `torlnk update` relaunches a daemon from this file, so it holds the whole
    // command line — and `--token <secret>` is in there verbatim. World-readable
    // was survivable when nothing pushed people toward tokens; `serve --web`
    // telling you to "pass --token to pin it across restarts" changes that.
    cleanup();
    const pid = spawnDaemon(NAME, ["-e", ""], process.cwd());
    expect(pid).toBeGreaterThan(0);

    expect(fs.statSync(runPathFor(NAME)).mode & 0o777).toBe(0o600);
    // The argv really is in there — otherwise this test would pass for the
    // wrong reason if the descriptor's shape ever changed.
    const desc = JSON.parse(fs.readFileSync(runPathFor(NAME), "utf8")) as { argv: string[] };
    expect(desc.argv).toContain("-e");
  });

  it("tightens a run descriptor that already exists at a looser mode", () => {
    cleanup();
    fs.mkdirSync(path.dirname(runPathFor(NAME)), { recursive: true });
    fs.writeFileSync(runPathFor(NAME), "{}\n", { mode: 0o644 });
    fs.chmodSync(runPathFor(NAME), 0o644);

    spawnDaemon(NAME, ["-e", ""], process.cwd());

    expect(fs.statSync(runPathFor(NAME)).mode & 0o777).toBe(0o600);
  });

  it("tightens a log file that already exists at a looser mode", () => {
    // The upgrade path, and the reason fchmod is called rather than trusting
    // openSync's mode argument: openSync only applies a mode when it *creates*
    // the file, so an install that has been running since before this change
    // would have kept its world-readable log forever.
    cleanup();
    fs.mkdirSync(path.dirname(logPathFor(NAME)), { recursive: true });
    fs.writeFileSync(logPathFor(NAME), "old log line\n", { mode: 0o644 });
    fs.chmodSync(logPathFor(NAME), 0o644);
    expect(fs.statSync(logPathFor(NAME)).mode & 0o777).toBe(0o644);

    spawnDaemon(NAME, ["-e", ""], process.cwd());

    expect(fs.statSync(logPathFor(NAME)).mode & 0o777).toBe(0o600);
    // Appended to, not truncated: a rotated-away log would lose the history a
    // user is being pointed at.
    expect(fs.readFileSync(logPathFor(NAME), "utf8")).toContain("old log line");
  });
});
