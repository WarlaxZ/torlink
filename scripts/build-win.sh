#!/usr/bin/env bash
# Cross-build a self-contained Windows x64 bundle from any platform (e.g. WSL/Linux).
#
# Produces build/torlnk-windows-x64/ (run torlnk.cmd) and build/torlnk-windows-x64.zip.
# The bundle carries its own node.exe, so the target machine needs no Node install.
set -euo pipefail

NODE_VER="${NODE_VER:-v22.23.1}"
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
BUILD="$ROOT/build"
STAGE="$BUILD/torlnk-windows-x64"
NODE_DIST="node-${NODE_VER}-win-x64"

echo "==> Building dist/"
cd "$ROOT"
npm run build

echo "==> Fetching Windows node.exe (${NODE_VER})"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$BUILD/.cache"
if [ ! -f "$BUILD/.cache/${NODE_DIST}.zip" ]; then
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/${NODE_DIST}.zip" \
    -o "$BUILD/.cache/${NODE_DIST}.zip"
fi
unzip -oq "$BUILD/.cache/${NODE_DIST}.zip" "${NODE_DIST}/node.exe" -d "$BUILD/.cache"
cp "$BUILD/.cache/${NODE_DIST}/node.exe" "$STAGE/node.exe"

echo "==> Installing production dependencies (win32-x64 prebuilds ship in-package)"
PKGSTAGE="$BUILD/.pkg"
rm -rf "$PKGSTAGE"
mkdir -p "$PKGSTAGE"
cp package.json package-lock.json "$PKGSTAGE/"
( cd "$PKGSTAGE" && npm ci --omit=dev --ignore-scripts >/dev/null )
cp -R "$PKGSTAGE/node_modules" "$STAGE/node_modules"

# Most native deps (utp-native, bufferutil, ...) ship prebuilds in-package via prebuildify, so they
# already work cross-platform. But some (e.g. node-datachannel) DOWNLOAD a platform-specific binary at
# install time via prebuild-install into build/Release/. --ignore-scripts (and building on Linux) skips
# that, so we fetch the win32-x64 binary explicitly for every such package.
echo "==> Fetching win32-x64 prebuilds for download-on-install native modules"
PREBUILD_BIN="$STAGE/node_modules/.bin/prebuild-install"
mapfile -t PREBUILD_PKGS < <(cd "$STAGE" && node -e '
const {readdirSync,readFileSync,existsSync}=require("fs");
const {join}=require("path");
const out=[];
const scan=(base)=>{ if(!existsSync(base)) return;
  for(const name of readdirSync(base)){
    if(name.startsWith(".")) continue;
    const dir=join(base,name);
    if(name.startsWith("@")){ scan(dir); continue; }
    const pj=join(dir,"package.json");
    if(!existsSync(pj)) continue;
    try{ const p=JSON.parse(readFileSync(pj,"utf8"));
      const inst=(p.scripts&&p.scripts.install)||"";
      if(inst.includes("prebuild-install")) out.push(dir+"\t"+(inst.includes("napi")?"napi":"node"));
    }catch{}
  }
};
scan("node_modules");
process.stdout.write(out.join("\n"));
')
if [ "${#PREBUILD_PKGS[@]}" -eq 0 ] || [ -z "${PREBUILD_PKGS[0]:-}" ]; then
  echo "  (none found)"
else
  for entry in "${PREBUILD_PKGS[@]}"; do
    pkgdir="${entry%%$'\t'*}"; runtime="${entry##*$'\t'}"
    ( cd "$STAGE/$pkgdir" && node "$PREBUILD_BIN" -r "$runtime" --platform win32 --arch x64 >/dev/null )
    echo "  ok: ${pkgdir#node_modules/} ($runtime)"
  done
fi

echo "==> Assembling bundle"
cp -R dist "$STAGE/dist"
cp package.json LICENSE README.md "$STAGE/"
# Windows launcher: run the TUI via the bundled node.exe.
printf '@echo off\r\n"%%~dp0node.exe" "%%~dp0dist\\cli.cjs" %%*\r\n' > "$STAGE/torlnk.cmd"

echo "==> Zipping"
cd "$BUILD"
rm -f torlnk-windows-x64.zip
if command -v zip >/dev/null 2>&1; then
  zip -qr torlnk-windows-x64.zip torlnk-windows-x64
else
  # zip(1) not installed (common on minimal WSL): fall back to Python's zipfile.
  python3 -c "import shutil; shutil.make_archive('torlnk-windows-x64','zip','.', 'torlnk-windows-x64')"
fi
cd "$ROOT"

echo
echo "Done."
echo "  Folder: $STAGE"
echo "  Zip:    $BUILD/torlnk-windows-x64.zip"
echo "  Run on Windows: unzip, then double-click torlnk.cmd (or run it in a terminal)."
