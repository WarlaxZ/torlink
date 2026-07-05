#!/bin/sh
set -eu

repo="${TORLINK_REPO:-WarlaxZ/torlink}"
install_dir="${TORLINK_INSTALL_DIR:-$HOME/.local/bin}"
runtime_dir="${TORLINK_RUNTIME_DIR:-$HOME/.local/share/torlnk}"
os=$(uname -s)
arch=$(uname -m)

case "$os:$arch" in
  Linux:x86_64|Linux:amd64) asset=torlnk-linux-x64.tar.gz ;;
  Darwin:x86_64) asset=torlnk-macos-x64.tar.gz ;;
  Darwin:arm64) asset=torlnk-macos-arm64.tar.gz ;;
  *) echo "No prebuilt torlnk binary for $os/$arch" >&2; exit 1 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
base="https://github.com/$repo/releases/latest/download"
curl -fL "$base/$asset" -o "$tmp/$asset"
curl -fL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp" && grep "  $asset\$" SHA256SUMS | sha256sum -c -)
else
  (cd "$tmp" && grep "  $asset\$" SHA256SUMS | shasum -a 256 -c -)
fi
tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$install_dir"
rm -rf "$runtime_dir"
mkdir -p "$(dirname "$runtime_dir")"
mv "$tmp/torlnk-runtime" "$runtime_dir"
printf '%s\n' '#!/bin/sh' "exec \"$runtime_dir/node\" \"$runtime_dir/dist/cli.cjs\" \"\$@\"" > "$install_dir/torlnk"
chmod 755 "$install_dir/torlnk"
echo "Installed torlnk to $install_dir/torlnk"
