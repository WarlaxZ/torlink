import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configFile, logFile, postersDir } from "../config/paths";

// The result of probing one directory: whether torlink can create it and write
// a file inside it, and — when it can't — the errno that says why.
export interface DirWriteCheck {
  dir: string;
  writable: boolean;
  code?: string;
}

// Everything the message needs that isn't in the per-dir checks: who we run as,
// which root the dirs live under, and who owns that root. `uid`/`ownerUid` are
// undefined where POSIX uids don't apply (Windows) or the root couldn't be
// stat-ed — the message adapts rather than printing "undefined".
export interface StateDirContext {
  uid?: number;
  stateRoot: string;
  ownerUid?: number;
}

/**
 * A loud, actionable warning when torlink can't write parts of its state
 * directory, or null when every directory is writable.
 *
 * Kept pure — the caller probes the filesystem and hands the results here — so
 * the exact wording is unit-tested without a real unwritable directory to set
 * up. This exists because the poster cache and the logger both swallow EACCES
 * (by design: a logging or caching failure must never crash a download), which
 * once turned a root-owned Docker bind mount into a silent "all posters blank,
 * no log file" with nothing on screen to explain it.
 */
export function formatStateDirWarning(
  checks: readonly DirWriteCheck[],
  ctx: StateDirContext,
): string | null {
  const failed = checks.filter((c) => !c.writable);
  if (failed.length === 0) return null;

  const lines: string[] = [
    "warning: torlink cannot write its state directory — posters, logs and the download queue will not persist.",
  ];
  // Only the failing paths: a warning that also lists the directories that work
  // reads as noise and buries the ones that matter.
  for (const f of failed) {
    lines.push(`  cannot write ${f.dir}${f.code ? ` (${f.code})` : ""}`);
  }

  const { uid, ownerUid, stateRoot } = ctx;
  const chownHint = (): string =>
    `  if ${stateRoot} is a Docker bind mount, run on the host: chown -R ${uid}:${uid} <the mounted directory>`;

  if (uid !== undefined && ownerUid !== undefined && uid !== ownerUid) {
    // The case this whole check exists for: a non-root process against a
    // root-owned bind mount. Naming both uids turns "permission denied" into a
    // fix the operator can paste.
    lines.push(`  running as uid ${uid}, but ${stateRoot} is owned by uid ${ownerUid}.`);
    lines.push(chownHint());
  } else if (uid !== undefined && ownerUid === undefined) {
    // Couldn't stat the root, so can't prove a mismatch — but a uid is still
    // worth offering the same fix against, since a bind mount is the usual cause.
    lines.push(`  running as uid ${uid}.`);
    lines.push(chownHint());
  } else {
    // uid === ownerUid, or uids don't apply: ownership is fine or irrelevant, so
    // chown is the wrong advice. This is a mode problem (e.g. a 0555 directory).
    lines.push("  the directory exists but is not writable — check its permissions.");
  }
  return lines.join("\n");
}

// Try to create `dir` and write (then remove) a probe file in it. Never throws:
// a failure is reported as `{ writable: false, code }`, which is the whole point
// — this is the one place that must NOT swallow the error it finds.
async function probeDir(dir: string): Promise<DirWriteCheck> {
  const probe = path.join(dir, `.torlnk-write-test-${randomUUID()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, "");
    await fs.rm(probe, { force: true });
    return { dir, writable: true };
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : undefined;
    return { dir, writable: false, ...(code ? { code } : {}) };
  }
}

/**
 * Probe the three directories torlink persists to — config, data and cache —
 * and return a warning string if any is unwritable, else null. The dirs are
 * derived from the leaf paths in config/paths.ts (which honour TORLINK_STATE_DIR)
 * so this tracks wherever state actually lives.
 *
 * `dirs` and `stateRoot` are injectable so the probe can be exercised against a
 * temp directory in tests; the defaults are the real locations.
 */
export async function checkStateDirsWritable(opts: {
  dirs?: readonly string[];
  stateRoot?: string;
} = {}): Promise<string | null> {
  const dataDir = path.dirname(logFile);
  const configDir = path.dirname(configFile);
  const cacheDir = path.dirname(postersDir);
  const dirs = opts.dirs ?? [configDir, dataDir, cacheDir];
  // The nearest common ancestor of the state dirs is the mount that needs fixing
  // (TORLINK_STATE_DIR, or its platform default parent). dataDir's parent is that
  // root under the override; good enough for the hint without a new export.
  const stateRoot = opts.stateRoot ?? path.dirname(dataDir);

  const checks = await Promise.all(dirs.map(probeDir));
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let ownerUid: number | undefined;
  try {
    ownerUid = (await fs.stat(stateRoot)).uid;
  } catch {
    ownerUid = undefined;
  }
  return formatStateDirWarning(checks, { uid, stateRoot, ...(ownerUid !== undefined ? { ownerUid } : {}) });
}
