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
    // `.claude/**` holds git worktrees — whole second checkouts of this repo.
    // Linting them lints the tree twice and fails on the parser's "multiple
    // candidate TSConfigRootDirs" before it reports anything useful.
    ignores: ["dist/**", ".claude/**", "**/*.cjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mjs}"],
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
    // The layering rule the src/core/ extraction exists for, enforced. Nothing
    // checked it before: adding `import { COLOR } from "../ui/theme"` to
    // src/core/search.ts passed lint, typecheck, build and the whole test suite.
    // core/ is the front-end-agnostic middle — the TUI and the web UI both sit on
    // it — so an import in the other direction quietly makes it depend on one of
    // them, and the next front-end inherits Ink.
    files: ["src/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/ui/**", "**/web/**"],
              message:
                "src/core must not import from src/ui or src/web: it is the front-end-agnostic layer both of them sit on. Move the shared piece down into core (or into util), or pass it in.",
            },
          ],
        },
      ],
    },
  },
  {
    // Same rule one layer out, and for the same reason: the web UI is a second
    // front-end over core, not a consumer of the first one. src/ui is Ink and
    // React — importing it from src/web would pull a terminal renderer toward a
    // browser bundle. (The reverse is allowed and real: src/ui/App.tsx hosts
    // src/web's server in-process.)
    files: ["src/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/ui/**"],
              message:
                "src/web must not import from src/ui: they are two front-ends over src/core, and src/ui pulls in Ink and React. Share through src/core or src/util instead.",
            },
          ],
        },
      ],
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
