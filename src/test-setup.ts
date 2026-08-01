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

// Never let a test reach the hosted reccd. `ensureReccAccount` is called from
// two fire-and-forget sites now (App.tsx, serve.ts's runServe), and any test
// that renders App or calls runServe without remembering to mock
// "../recc/provision" would otherwise POST a real anonymous signup to
// https://reccd.stream — that endpoint is rate-limited to 3/hour per IP, and
// it already happened once (see App.web.test.tsx's mock, added after the
// fact). `shouldProvision` (src/recc/provision.ts) treats any reccUrl other
// than the default host as self-hosted and refuses to sign up against it, so
// pointing TORLINK_RECC_URL at a bogus non-default host here makes every
// unmocked call site a no-op network-wise, without weakening any assertion —
// tests that specifically exercise reccd's default-host behaviour
// (provision.test.ts, config.test.ts, routes.test.ts) already set or clear
// this env var themselves per test, which overrides this default.
process.env.TORLINK_RECC_URL = "http://torlink-test-guard.invalid";
