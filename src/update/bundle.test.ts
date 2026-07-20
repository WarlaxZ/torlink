import { describe, it, expect } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { assetNameFor, isBundleInstall, verifySha256, swapInPlace, type SwapDeps } from "./bundle";

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
