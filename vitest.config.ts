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
  },
});
