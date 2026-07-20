import { describe, it, expect } from "vitest";
import path from "node:path";
import { assetNameFor, isBundleInstall } from "./bundle";

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
