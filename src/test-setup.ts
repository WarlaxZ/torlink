import os from "node:os";
import path from "node:path";

// Give every vitest worker its own on-disk state directory so concurrent
// workers never share torlink's persisted files (queue / history / seeds /
// config / torrents) and race on them.
//
// This must run before any module imports src/config/paths.ts, which resolves
// those paths once at load from TORLINK_STATE_DIR. setupFiles are evaluated
// before the test module's import graph, so the override lands in time. This
// file deliberately imports nothing from the app, so paths.ts is not pulled in
// early.
//
// VITEST_WORKER_ID is stable for a worker's lifetime and distinct across
// concurrent workers; the pid disambiguates the forks pool, where a fresh
// process can reuse a worker id.
//
// The parent directory comes from globalSetup (src/test-globalSetup.ts), which
// creates one per run and removes it when every worker has finished — these
// directories used to be left behind on every run. The fallback keeps this file
// working if it is ever loaded without that globalSetup (a bare
// `vitest --config` invocation, a future config split).
const workerTag = `${process.pid}-${process.env.VITEST_WORKER_ID ?? "0"}`;
const root = process.env.TORLINK_TEST_STATE_ROOT ?? path.join(os.tmpdir(), "torlink-test-state");
process.env.TORLINK_STATE_DIR = path.join(root, workerTag);
