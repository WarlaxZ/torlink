import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Owns the lifetime of the per-worker state directories that src/test-setup.ts
// hands out. It has to live here, not there: setupFiles run once per *test file*,
// so an afterAll in that file would delete a directory the next file in the same
// worker is still using. globalSetup's teardown is the only hook that runs when
// every worker is finished.
//
// One root per run, made with mkdtemp, so two concurrent runs (a `vitest run`
// alongside a watch session, or two checkouts) cannot delete each other's state
// — the reason this isn't just an rm of a fixed `torlink-test-state` path.
//
// Without this the run leaves one directory per worker behind every time; they
// had accumulated into 1248 directories / 22 MB of /tmp on one dev machine.
export default function setup(): () => void {
  const root = mkdtempSync(path.join(os.tmpdir(), "torlink-test-state-"));
  // Read by src/test-setup.ts in each worker. Workers are forked after this
  // returns, so they inherit it.
  process.env.TORLINK_TEST_STATE_ROOT = root;
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
