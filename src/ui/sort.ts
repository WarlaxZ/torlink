// The TUI's import site for the shared result sort.
//
// The implementation moved to `src/util/resultSort.ts` when the browser search
// UI needed the same orders: `src/web/static/` is a browser bundle and is
// lint-forbidden from importing `src/ui/**`, so the only place both front-ends
// can reach is `src/util`. This file stays so every `../sort` / `./sort` import
// in the TUI keeps working, and so there is never a second copy to drift.
export * from "../util/resultSort";
