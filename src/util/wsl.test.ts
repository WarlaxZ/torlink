import { describe, it, expect } from "vitest";
import { isWsl, wslPathFromWindows } from "./wsl";

describe("isWsl", () => {
  it("is true only for a Linux process with WSL_DISTRO_NAME set", () => {
    // process.platform is fixed for the running test, so drive the env branch
    // and let the platform guard be exercised by the two-condition shape.
    const linuxOnly = process.platform === "linux";
    expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu" })).toBe(linuxOnly);
    expect(isWsl({})).toBe(false);
  });
});

describe("wslPathFromWindows", () => {
  it("maps a drive-letter path with backslashes onto the /mnt interop mount", () => {
    expect(wslPathFromWindows("C:\\Users\\u\\Downloads\\a.torrent")).toBe(
      "/mnt/c/Users/u/Downloads/a.torrent",
    );
  });
  it("lower-cases the drive letter", () => {
    expect(wslPathFromWindows("D:\\media\\a.torrent")).toBe("/mnt/d/media/a.torrent");
  });
  it("accepts forward slashes too (a file:// path already decoded to C:/…)", () => {
    expect(wslPathFromWindows("C:/Users/u/a.torrent")).toBe("/mnt/c/Users/u/a.torrent");
  });
  it("preserves spaces and parens in the name", () => {
    expect(wslPathFromWindows("C:\\Users\\u\\My Show (2024).torrent")).toBe(
      "/mnt/c/Users/u/My Show (2024).torrent",
    );
  });
  it("honours a custom mount root for automount-root=/ setups", () => {
    expect(wslPathFromWindows("C:\\a.torrent", "/")).toBe("/c/a.torrent");
  });
  it("handles a bare drive root", () => {
    expect(wslPathFromWindows("C:\\")).toBe("/mnt/c");
  });
  it("returns null for anything that isn't a drive-letter path", () => {
    expect(wslPathFromWindows("/home/u/a.torrent")).toBe(null);
    expect(wslPathFromWindows("~/a.torrent")).toBe(null);
    expect(wslPathFromWindows("\\\\server\\share\\a.torrent")).toBe(null);
    expect(wslPathFromWindows("the matrix 1999")).toBe(null);
  });
});
