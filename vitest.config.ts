import { configDefaults } from "vitest/config";
import { defineConfig } from "vitest/config";

// Keep tests off the real user data dir and isolated from each other: each
// worker gets its own TORLINK_STATE_DIR (which src/config/paths.ts honors) so
// concurrent workers never share persisted state — queue / history / seeds /
// config / torrents — and race on it. See src/test-setup.ts for the per-worker
// path; it must run before any test module imports paths.ts, which setupFiles
// guarantee.
export default defineConfig({
  test: {
    setupFiles: ["./src/test-setup.ts"],
    // The real-socket tests (serve.launch / shutdown) wait up to waitUntil's own
    // 5s budget for a server to bind and print its boot line. With vitest's 5s
    // default there is no headroom left, so a loaded CI runner tips them into a
    // bare "Test timed out in 5000ms" flake (seen on node 24 / ubuntu). Raise the
    // ceiling: the fast majority still finish in milliseconds — only genuinely
    // slow or hung tests ever reach it.
    testTimeout: 15000,
    // `.claude/**` holds git worktrees — whole second checkouts of this repo.
    // Without this the suite runs every test twice, once against a stale copy,
    // and a failure there reads as a failure here.
    exclude: [...configDefaults.exclude, ".claude/**"],
    // Creates the parent directory those per-worker dirs live in and removes it
    // once every worker is done. setupFiles cannot clean up after themselves:
    // they run per test file, and several files share a worker's directory.
    globalSetup: ["./src/test-globalSetup.ts"],
  },
});
