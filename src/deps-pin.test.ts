import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { arr2hex } from "uint8-util";

// Jul-2026 incident: uint8-util 2.3.x (released Jul-20) changed arr2hex to
// read data.buffer, which throws on the hex STRING webtorrent 2.8.5 passes it
// from Torrent._onTorrentId. That surfaces as an unhandled promise rejection
// inside webtorrent's fire-and-forget async startup, unreachable by any
// caller's try/catch, and it killed every fresh install on every magnet add
// and every boot with saved downloads (the repo lockfile kept dev and CI on
// the tolerant 2.2.6, which is why nothing here ever saw it). The exact pin,
// as a direct dependency AND an override, keeps fresh installs deduped onto
// the known-good version. Lift it deliberately, with this test, only once the
// upstream call site or arr2hex handles strings again.
const KNOWN_GOOD = "2.2.6";

function readText(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function readJson(rel: string): Record<string, any> {
  return JSON.parse(readText(rel));
}

// The project uses pnpm: overrides live in pnpm-workspace.yaml (pnpm does not
// read npm's `overrides` field) and the resolved tree is in pnpm-lock.yaml.
// Both are plain, regular YAML, so the few values these tests need are read
// with a line match rather than pulling in a YAML dependency just for a test.

/** The `overrides:` block of pnpm-workspace.yaml as name -> range. */
function readOverrides(): Record<string, string> {
  const out: Record<string, string> = {};
  let inBlock = false;
  for (const line of readText("../pnpm-workspace.yaml").split("\n")) {
    if (/^overrides:\s*$/.test(line)) {
      inBlock = true;
    } else if (inBlock && /^\S/.test(line)) {
      inBlock = false;
    } else if (inBlock) {
      const m = /^\s+["']?([^"':]+?)["']?:\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
      const [, key, value] = m ?? [];
      if (key !== undefined && value !== undefined) out[key] = value;
    }
  }
  return out;
}

/** Every version of `name` that pnpm-lock.yaml resolved, from its `packages:` section. */
function lockedVersions(name: string): string[] {
  const lock = readText("../pnpm-lock.yaml");
  // pnpm-lock.yaml starts with a short document describing the pinned pnpm
  // itself, so take the LAST `packages:` section, which is the project's.
  const sections = lock.split(/^packages:\s*$/m);
  const packages = (sections[sections.length - 1] ?? "").split(/^snapshots:\s*$/m)[0] ?? "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const re = new RegExp(`^  '?${escaped}@([^':\\s]+)'?:\\s*$`, "gm");
  return [...packages.matchAll(re)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

describe("uint8-util quarantine pin", () => {
  it("package.json pins the exact version as a dependency, and pnpm-workspace.yaml as an override", () => {
    const pkg = readJson("../package.json");
    expect(pkg.dependencies["uint8-util"]).toBe(KNOWN_GOOD);
    expect(readOverrides()["uint8-util"]).toBe(KNOWN_GOOD);
  });

  it("the lockfile resolved the pinned version", () => {
    expect(lockedVersions("uint8-util")).toEqual([KNOWN_GOOD]);
  });

  it("the resolved arr2hex tolerates webtorrent's string infoHash call", () => {
    const asAny = arr2hex as unknown as (data: unknown) => string;
    expect(() => asAny("fd568f2ceba6b2603e761e4b13e5308c8b0f8ae4")).not.toThrow();
  });
});

// Aug-2026 install breakage: node-datachannel 0.33.0 removed its `install`
// script entirely (0.32.3 ran `prebuild-install -r napi || (npm install
// --ignore-scripts --production=false && npm run _prebuild)`) and moved the
// native binary into nine per-platform optionalDependencies. npm 12 blocks
// install scripts that are not explicitly approved, so on 0.32.3 a fresh
// install leaves node-datachannel without its binary and every import of it
// throws "Cannot find module '../../../build/Release/node_datachannel.node'" —
// the failure behind #166, #60, #81, #89, #135 and #20. Optional dependencies
// need no script at all. webrtc-polyfill still asks for "^0.32.3", and a caret
// on a 0.x version pins the minor, so only an override moves the tree onto the
// prebuilt line. The 0.33 loader still checks a local build/ directory before
// the platform package, which keeps scripts/ensure-webrtc.cjs working as the
// compile-from-source fallback where no prebuilt exists.
const PREBUILT_LINE = "^0.33.1";
const ANDROID_PUBLISHED = "0.33.0";

function atLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

describe("node-datachannel prebuilt binaries", () => {
  it("pnpm-workspace.yaml overrides the transitive range onto the prebuilt line", () => {
    expect(readOverrides()["node-datachannel"]).toBe(PREBUILT_LINE);
  });

  it("the lockfile resolved a version that ships prebuilt binaries", () => {
    const resolved = lockedVersions("node-datachannel");
    expect(resolved.length).toBeGreaterThan(0);
    for (const version of resolved) expect(atLeast(version, "0.33.1")).toBe(true);
  });

  it("the installed copy carries no install script and declares platform packages", () => {
    const installed = readJson("../node_modules/node-datachannel/package.json");
    expect(installed.scripts?.install).toBeUndefined();
    expect(Object.keys(installed.optionalDependencies ?? {})).toEqual(
      expect.arrayContaining([
        "@node-datachannel/linux-x64-gnu",
        "@node-datachannel/darwin-arm64",
        "@node-datachannel/win32-x64-msvc",
      ]),
    );
  });

  it("the native binding loads without any build step", async () => {
    const ndc = await import("node-datachannel");
    expect(typeof ndc.PeerConnection).toBe("function");
  });

  // 0.33.1 lists @node-datachannel/android-arm64@0.33.1 among its
  // optionalDependencies and that version was never published -- 0.33.0 is the
  // only one on the registry. npm then leaves the package out of the lockfile,
  // and `npm ci` refuses the result outright: "Missing:
  // @node-datachannel/android-arm64@ from lock file". So the override names the
  // version that does exist. 0.33.1 only added a Windows ARM64 build, so the
  // Android binary is the same one either way. Drop this once upstream
  // publishes the missing package.
  it("pins the platform package upstream declares but never published", () => {
    expect(readOverrides()["@node-datachannel/android-arm64"]).toBe(ANDROID_PUBLISHED);
    expect(lockedVersions("@node-datachannel/android-arm64")).toEqual([ANDROID_PUBLISHED]);
  });

  it("the lockfile carries every platform package the module declares", () => {
    const declared = Object.keys(
      readJson("../node_modules/node-datachannel/package.json").optionalDependencies ?? {},
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(lockedVersions(name), `${name} missing from the lockfile`).not.toHaveLength(0);
    }
  });
});
