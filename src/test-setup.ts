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
const workerTag = `${process.pid}-${process.env.VITEST_WORKER_ID ?? "0"}`;
process.env.TORLINK_STATE_DIR = path.join(os.tmpdir(), "torlink-test-state", workerTag);
