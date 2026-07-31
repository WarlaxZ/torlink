import { defineConfig } from "tsup";

// The web UI's browser bundle. A separate config *file* invoked as a separate
// `tsup` run (see the `build` script), deliberately NOT a second entry in an
// array in tsup.config.ts.
//
// Do not merge this back into an array there. tsup runs array configs
// concurrently — `Promise.all` over the config list, where each config's build
// begins by globbing `**/*` out of its own outDir — so the Node build's
// `clean: true` on `dist` races this build's write to `dist/web`. When the clean
// loses that race the CLI is fine and `app.js` is silently gone, while postbuild
// still copies index.html, so `findStaticDir()` succeeds and the dashboard
// serves a page whose `<script src="/app.js">` 404s. Tracing that back to a
// build race is miserable. Sequencing the two `tsup` invocations makes the order
// explicit: the Node clean wipes `dist`, then this build creates and owns
// `dist/web`.
//
// Because this run owns `dist/web` outright, `clean: true` is both safe and
// wanted here: it is scoped to `outDir`, so it cannot touch the CLI output, and
// it means a static file deleted from source stops shipping instead of lingering.
//
// This build is also the enforcement point for `src/web/static/` being
// browser-safe: `platform: "browser"` fails loudly on any Node builtin, and
// unlike a source-text grep it follows transitive imports. That is why there is
// no test asserting those files import nothing.
export default defineConfig({
  // One entry per page: the dashboard and the player share only a stylesheet, so
  // there is still no shared chunk worth extracting between the two.
  entry: { app: "src/web/static/app.ts", player: "src/web/static/player.ts" },
  outDir: "dist/web",
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  clean: true,
  // Kept alongside `minify` on purpose. The bundle is a few KB, so minifying
  // buys little over gzip, but it does mangle dashboard.ts — the most
  // interesting logic here — into single-letter identifiers, and a bug report
  // with a stack trace into `function O(e)` is unactionable. Browsers fetch a
  // sourcemap only when devtools is open, so this costs real users nothing.
  sourcemap: true,
  // tsup treats everything in package.json `dependencies` as external, which for
  // a BROWSER bundle is silently wrong: an external dep is left as a bare
  // `import … from "parse-torrent-title"`, the build reports success, and the
  // page then dies in the browser on a specifier no browser can resolve. Nothing
  // in the test suite can see that — there is no jsdom here — so the enforcement
  // has to be this line.
  //
  // Bundling it is safe: parse-torrent-title is two files of regexes with no
  // imports of its own, and `platform: "browser"` above still fails the build if
  // anything pulled in here ever reaches a Node builtin. It arrives via
  // `src/util/nextEpisodeFile.ts` -> `src/util/release.ts`, the release parser
  // both front ends share.
  //
  // hls.js is here for the same reason. It is dynamically imported by
  // hlsMount.ts so a direct-play mp4 never fetches it, which makes it a separate
  // chunk rather than part of player.js — but left external it would emit a bare
  // `import("hls.js")` that resolves to nothing in a browser, and the failure
  // would appear only when someone opened an MKV.
  noExternal: [/^parse-torrent-title$/, /^hls\.js$/],
  dts: false,
  // ON, and it has to be. hlsMount.ts imports hls.js dynamically so that a
  // direct-play mp4 never downloads it — but with splitting off, esbuild inlines
  // a dynamic import into its entry, and `player.js` went from 16 KB to 523 KB
  // with every page load paying for it. Splitting is what turns that import back
  // into a chunk fetched only when an HLS manifest is actually mounted.
  splitting: true,
  minify: true,
});
