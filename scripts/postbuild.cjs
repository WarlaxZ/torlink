'use strict';

const { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const src = resolve(root, 'scripts/cli-entry.cjs');
const dest = resolve(root, 'dist/cli.cjs');

copyFileSync(src, dest);
// The WebRTC fallback stub must ship beside cli.cjs, which resolves it via
// __dirname when the node-datachannel binary is unavailable.
copyFileSync(resolve(root, 'scripts/webrtc-stub.mjs'), resolve(root, 'dist/webrtc-stub.mjs'));

// The web UI's HTML and CSS aren't bundled by tsup (only the .ts entries are),
// so copy them next to the generated dist/web/*.js. A page added to
// tsup.web.config.ts needs its HTML added here too, or the bundle ships with
// nothing loading it.
const webOut = resolve(root, 'dist/web');
mkdirSync(webOut, { recursive: true });
for (const file of ['index.html', 'player.html', 'styles.css']) {
  copyFileSync(resolve(root, 'src/web/static', file), resolve(webOut, file));
}

// Nothing in a browser bundle may keep an unresolved import. tsup externalises
// everything in `dependencies` by default, so a `src/web/static` module that
// imports an npm package builds "successfully" and then dies on load with a
// bare specifier the browser cannot resolve — and with no jsdom here, no test
// can see it. That shipped once (`parse-torrent-title`, fixed with `noExternal`
// in tsup.web.config.ts). `node:*` is the same failure with a different cause,
// and the same fix does not apply: that one means the wrong code moved into
// `static/`. Fail the build rather than print success over a broken dashboard.
// The lookbehind is load-bearing: `\b` alone matches the `from` in
// `Array.from("abc")` and fails the build advising you to add `abc` to
// `noExternal`. A guard that cries wolf gets deleted, which costs more than the
// bug it was watching for. `.`, a word character, or `$` before the keyword
// means it is a property access, not an import.
const BARE_IMPORT = /(?<![.\w$])(?:from|import)\s*\(?\s*["'](?![./])([^"']+)["']/g;
const stowaways = new Map();
for (const file of readdirSync(webOut).filter((f) => f.endsWith('.js'))) {
  const code = readFileSync(resolve(webOut, file), 'utf8');
  for (const [, spec] of code.matchAll(BARE_IMPORT)) {
    if (!stowaways.has(spec)) stowaways.set(spec, file);
  }
}
if (stowaways.size > 0) {
  const lines = [...stowaways].map(([spec, file]) => `  ${spec}  (dist/web/${file})`);
  console.error(
    `postbuild: the browser bundle keeps ${stowaways.size} unresolved import(s):\n${lines.join('\n')}\n` +
      "A 'node:*' specifier means node-only code reached src/web/static/ — move it to src/core or src/util.\n" +
      'Anything else is an npm package tsup externalised — add it to `noExternal` in tsup.web.config.ts.',
  );
  process.exit(1);
}

// On Windows chmod is effectively a no-op, and npm re-applies bin permissions on install anyway, so a failure
// here shouldn't fail the build, but warn rather than swallow the error.
try {
  chmodSync(dest, 0o755);
} catch (err) {
  console.warn('postbuild: could not set executable bit on dist/cli.cjs:', err.message);
}

console.log('postbuild: wrote dist/cli.cjs, dist/webrtc-stub.mjs and the web assets in dist/web');
