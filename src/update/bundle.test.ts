import { describe, it, expect } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  assetNameFor,
  isBundleInstall,
  verifySha256,
  swapInPlace,
  type SwapDeps,
  applyBundleUpdate,
  type ApplyDeps,
} from "./bundle";
import type { GithubRelease } from "./github";

describe("assetNameFor", () => {
  it("maps supported platform/arch pairs to release asset names", () => {
    expect(assetNameFor("linux", "x64")).toBe("torlnk-linux-x64.tar.gz");
    expect(assetNameFor("darwin", "x64")).toBe("torlnk-macos-x64.tar.gz");
    expect(assetNameFor("darwin", "arm64")).toBe("torlnk-macos-arm64.tar.gz");
    expect(assetNameFor("win32", "x64")).toBe("torlnk-windows-x64.zip");
  });
  it("returns null for unsupported combinations", () => {
    expect(assetNameFor("linux", "arm64")).toBeNull();
    expect(assetNameFor("freebsd", "x64")).toBeNull();
  });
});

describe("isBundleInstall", () => {
  const root = path.join("/opt", "torlnk-runtime");
  it("is true when the running node lives inside the manifest root", () => {
    expect(isBundleInstall(root, path.join(root, "node"))).toBe(true);
  });
  it("is false when node is the system node (git/npm install)", () => {
    expect(isBundleInstall(root, "/usr/bin/node")).toBe(false);
  });
});

describe("verifySha256", () => {
  const data = Buffer.from("hello torlink");
  const digest = createHash("sha256").update(data).digest("hex");
  const sums = `${digest}  torlnk-linux-x64.tar.gz\ndeadbeef  other-file\n`;

  it("passes when the file digest matches its SHA256SUMS entry", () => {
    expect(verifySha256(data, "torlnk-linux-x64.tar.gz", sums)).toBe(true);
  });
  it("fails on a digest mismatch", () => {
    expect(verifySha256(Buffer.from("tampered"), "torlnk-linux-x64.tar.gz", sums)).toBe(false);
  });
  it("fails when the file has no entry in SHA256SUMS", () => {
    expect(verifySha256(data, "missing.tar.gz", sums)).toBe(false);
  });
});

function recordingDeps(overrides: Partial<SwapDeps> = {}): { deps: SwapDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: SwapDeps = {
    rename: (from, to) => {
      calls.push(`rename ${from} -> ${to}`);
    },
    rm: (target) => {
      calls.push(`rm ${target}`);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("swapInPlace", () => {
  it("moves the old runtime aside, moves the new one in, and deletes the old", () => {
    const { deps, calls } = recordingDeps();
    swapInPlace("/opt/torlnk-runtime", "/tmp/stage/torlnk-runtime", 123, deps);
    expect(calls).toEqual([
      "rename /opt/torlnk-runtime -> /opt/torlnk-runtime.old-123",
      "rename /tmp/stage/torlnk-runtime -> /opt/torlnk-runtime",
      "rm /opt/torlnk-runtime.old-123",
    ]);
  });

  it("rolls the old runtime back if moving the new one in fails", () => {
    const calls: string[] = [];
    const deps: SwapDeps = {
      rename: (from, to) => {
        calls.push(`rename ${from} -> ${to}`);
        if (from === "/tmp/stage/torlnk-runtime") throw new Error("cross-device");
      },
      rm: (target) => calls.push(`rm ${target}`),
    };
    expect(() => swapInPlace("/opt/torlnk-runtime", "/tmp/stage/torlnk-runtime", 123, deps)).toThrow();
    expect(calls).toEqual([
      "rename /opt/torlnk-runtime -> /opt/torlnk-runtime.old-123",
      "rename /tmp/stage/torlnk-runtime -> /opt/torlnk-runtime", // failed
      "rename /opt/torlnk-runtime.old-123 -> /opt/torlnk-runtime", // rollback
    ]);
  });
});

const release: GithubRelease = {
  version: "1.5.1",
  assets: [
    { name: "torlnk-linux-x64.tar.gz", url: "https://d/asset.tar.gz" },
    { name: "SHA256SUMS", url: "https://d/SHA256SUMS" },
  ],
  sha256Url: "https://d/SHA256SUMS",
};

function applyDeps(over: Partial<ApplyDeps> = {}): { deps: ApplyDeps; log: string[] } {
  const log: string[] = [];
  const deps: ApplyDeps = {
    platform: "linux",
    arch: "x64",
    download: async (url) => {
      log.push(`download ${url}`);
      return Buffer.from("archive-bytes");
    },
    readText: async (url) => {
      log.push(`readText ${url}`);
      return "sha  torlnk-linux-x64.tar.gz";
    },
    verify: () => {
      log.push("verify");
      return true;
    },
    extract: async (archive, dest) => {
      log.push(`extract ${archive} -> ${dest}`);
    },
    swap: () => log.push("swap"),
    tmpDir: () => "/tmp/torlnk-upd",
    write: async (p) => {
      log.push(`write ${p}`);
    },
    ...over,
  };
  return { deps, log };
}

describe("applyBundleUpdate", () => {
  it("downloads, verifies, extracts, and swaps in order", async () => {
    const { deps, log } = applyDeps();
    const ok = await applyBundleUpdate(release, "/opt/torlnk-runtime", deps);
    expect(ok).toBe(true);
    expect(log).toEqual([
      "download https://d/asset.tar.gz",
      "write /tmp/torlnk-upd/torlnk-linux-x64.tar.gz",
      "readText https://d/SHA256SUMS",
      "verify",
      "extract /tmp/torlnk-upd/torlnk-linux-x64.tar.gz -> /tmp/torlnk-upd/stage",
      "swap",
    ]);
  });

  it("aborts before swap when verification fails", async () => {
    const { deps, log } = applyDeps({ verify: () => false });
    const ok = await applyBundleUpdate(release, "/opt/torlnk-runtime", deps);
    expect(ok).toBe(false);
    expect(log).not.toContain("swap");
  });

  it("stops when the platform has no published asset", async () => {
    const { deps, log } = applyDeps({ platform: "linux", arch: "arm64" });
    const ok = await applyBundleUpdate(release, "/opt/torlnk-runtime", deps);
    expect(ok).toBe(false);
    expect(log).toEqual([]); // never tried to download
  });
});
