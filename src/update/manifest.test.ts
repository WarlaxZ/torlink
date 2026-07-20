import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { readManifest } from "./manifest";
import { repoUrlOf } from "./manifest";

describe("readManifest", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "torlink-manifest-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const urlIn = (...segments: string[]): string =>
    pathToFileURL(path.join(dir, ...segments, "module.js")).href;

  it("finds the nearest package.json with a name and version", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "some-pkg", version: "2.3.4" }));
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });

    expect(readManifest(urlIn("dist"))).toEqual({
      name: "some-pkg",
      version: "2.3.4",
      root: dir,
      repoUrl: null,
    });
  });

  it("walks past manifests missing a name or version", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "outer-pkg", version: "1.0.0" }));
    const inner = path.join(dir, "a", "b");
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, "package.json"), JSON.stringify({ type: "module" }));

    expect(readManifest(urlIn("a", "b"))?.name).toBe("outer-pkg");
  });

  it("resolves this repo's own manifest from the source tree", () => {
    const m = readManifest();
    expect(m?.name).toBe("torlink");
    expect(m?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("repoUrlOf", () => {
  it("reads a string repository field", () => {
    expect(repoUrlOf({ repository: "https://github.com/o/r" })).toBe("https://github.com/o/r");
  });
  it("reads the url from an object repository field", () => {
    expect(repoUrlOf({ repository: { url: "git+https://github.com/o/r.git" } })).toBe(
      "git+https://github.com/o/r.git",
    );
  });
  it("returns null when absent or malformed", () => {
    expect(repoUrlOf({})).toBeNull();
    expect(repoUrlOf({ repository: { url: 42 } })).toBeNull();
  });
});
