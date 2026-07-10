import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// Flat config (ESLint 9+). Kept deliberately lean so `npm run lint` stays green
// on the existing tree and is worth running: the recommended TS rules plus the
// two classic React Hooks rules the codebase already annotates against. We do
// not pull in eslint-plugin-react-hooks' newer React-Compiler rule set (via its
// `recommended-latest` config) — those are aggressive for an Ink TUI and would
// bury the useful signal in noise.
export default tseslint.config(
  {
    ignores: ["dist/**", "**/*.cjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Underscore-prefixed names are an intentional "unused" marker.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // This is a terminal UI: several regexes legitimately match ANSI escape
      // (\x1b) control characters to sanitize or interpret terminal output.
      "no-control-regex": "off",
      // Best-effort operations (clipboard, opening a folder, stat-ing a partial
      // download) intentionally swallow failures with an empty catch.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Flags idiomatic "declare a default, then assign in a try/catch or loop"
      // initializers; reviewed occurrences and none are bugs.
      "no-useless-assignment": "off",
      // A `let` that a closure reads before its single deferred assignment
      // (e.g. a timer whose own callback references it) genuinely can't be
      // const; don't flag that pattern.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // Tests lean on `any` for fixtures and deliberately-malformed input casts.
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
