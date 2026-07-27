'use strict';

const { chmodSync, copyFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const src = resolve(root, 'scripts/cli-entry.cjs');
const dest = resolve(root, 'dist/cli.cjs');

copyFileSync(src, dest);
// The WebRTC fallback stub must ship beside cli.cjs, which resolves it via
// __dirname when the node-datachannel binary is unavailable.
copyFileSync(resolve(root, 'scripts/webrtc-stub.mjs'), resolve(root, 'dist/webrtc-stub.mjs'));

// The web UI's HTML and CSS aren't bundled by tsup (only app.ts is), so copy
// them next to the generated dist/web/app.js.
const webOut = resolve(root, 'dist/web');
mkdirSync(webOut, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  copyFileSync(resolve(root, 'src/web/static', file), resolve(webOut, file));
}

// On Windows chmod is effectively a no-op, and npm re-applies bin permissions on install anyway, so a failure
// here shouldn't fail the build, but warn rather than swallow the error.
try {
  chmodSync(dest, 0o755);
} catch (err) {
  console.warn('postbuild: could not set executable bit on dist/cli.cjs:', err.message);
}

console.log('postbuild: wrote dist/cli.cjs, dist/webrtc-stub.mjs and the web assets in dist/web');
