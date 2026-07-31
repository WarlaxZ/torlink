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
