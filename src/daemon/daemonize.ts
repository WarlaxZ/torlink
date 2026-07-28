// Self-backgrounding for the headless commands: `--daemon` re-spawns this exact
// command detached from the terminal (own session, stdio to a log file), writes
// a pidfile plus a run descriptor, and exits the parent. You can then log out and
// it keeps running.
//
// The run descriptor is what lets `torlnk update` relaunch a daemon on its exact
// original command after rebuilding.
//
// NOTE: on a box with systemd, a `systemctl --user` service with linger is a
// sturdier way to run these (auto-restart, boot-start). This is the no-systemd
// convenience path.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logsDir } from "../config/paths";

const MARKER = "TORLINK_DAEMONIZED";

export function logPathFor(name: string): string {
  return path.join(logsDir, `${name}.log`);
}
export function pidPathFor(name: string): string {
  return path.join(logsDir, `${name}.pid`);
}
export function runPathFor(name: string): string {
  return path.join(logsDir, `${name}.run.json`);
}

// Records argv and cwd only, not env: a daemon relaunched after an update
// inherits the updater's environment, so env-dependent behavior (proxies,
// TORLINK_* overrides) follows the shell that ran `torlnk update`.
export interface RunDescriptor {
  name: string;
  pid: number;
  argv: string[]; // args to node (script path + subcommand + flags)
  cwd: string;
  startedAt: number;
}

// Spawn `node <argv>` detached with its own session and stdio pointed at the log,
// then record the pid and enough to relaunch it later. Shared by the initial
// --daemon fork and by a post-update restart, so both write the pidfile and
// descriptor the same way.
export function spawnDaemon(name: string, argv: string[], cwd: string): number {
  fs.mkdirSync(logsDir, { recursive: true });
  // 0600, and tightened on every spawn rather than only at creation: since
  // `serve --web` began minting a token for a non-loopback bind, this file can
  // contain a live credential — the daemon's stdout is where that token is
  // printed. It used to hold nothing worth reading, so it was created with the
  // default 0644 and every existing install still has one at that mode.
  // fchmod (not chmod) so the mode lands on the descriptor we just opened.
  const out = fs.openSync(logPathFor(name), "a", 0o600);
  // Best-effort, never fatal: this is hardening, and refusing to start a daemon
  // because a mode could not be set would be a worse outcome than a loose mode.
  // Windows models almost none of this (owner-only there is an ACL question),
  // which is the main reason it is allowed to fail quietly.
  try {
    fs.fchmodSync(out, 0o600);
  } catch {}
  const child = spawn(process.execPath, argv, {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, [MARKER]: "1" },
  });
  child.unref();
  const pid = child.pid ?? 0;
  if (pid) {
    // The pid is not a secret, so it keeps the default mode.
    fs.writeFileSync(pidPathFor(name), `${pid}\n`);
    // The run descriptor is, though: it stores the whole argv so `torlnk update`
    // can relaunch this daemon, and a `--token <secret>` lives in there verbatim.
    // 0600, and chmod'd unconditionally because writeFileSync's mode only
    // applies when it creates the file — an install that has been restarting a
    // daemon since before this would otherwise keep its world-readable copy.
    const desc: RunDescriptor = { name, pid, argv, cwd, startedAt: Date.now() };
    fs.writeFileSync(runPathFor(name), `${JSON.stringify(desc, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(runPathFor(name), 0o600);
    } catch {}
  }
  return pid;
}

// In the parent: fork a detached child and exit. In the already-detached child
// (marker set): return so the caller keeps running normally.
export function daemonize(name: string): void {
  if (process.env[MARKER] === "1") return;

  const pid = spawnDaemon(name, process.argv.slice(1), process.cwd());
  const logPath = logPathFor(name);
  const pidPath = pidPathFor(name);

  console.log(`torlink ${name} daemon started (pid ${pid}).`);
  console.log(`  logs: ${logPath}`);
  // Said out loud because `--daemon` is the one launch that does not end with a
  // dashboard on screen: the child's stdout is the log file, so the browsable
  // link — and a minted token, when there is one — is in there and nowhere else.
  // Without this the user gets a pid and has to guess where the address went.
  if (process.argv.includes("--web")) console.log(`  web ui: the link is in that log`);
  console.log(`  stop: kill ${pid}   (or: kill $(cat ${pidPath}))`);
  process.exit(0);
}
