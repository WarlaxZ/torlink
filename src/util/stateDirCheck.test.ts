import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatStateDirWarning, checkStateDirsWritable, type DirWriteCheck } from "./stateDirCheck";

const ok = (dir: string): DirWriteCheck => ({ dir, writable: true });
const bad = (dir: string, code = "EACCES"): DirWriteCheck => ({ dir, writable: false, code });

describe("formatStateDirWarning", () => {
  it("returns null when every directory is writable", () => {
    const checks = [ok("/state/config"), ok("/state/data"), ok("/state/cache")];
    expect(formatStateDirWarning(checks, { uid: 1000, stateRoot: "/state", ownerUid: 1000 })).toBeNull();
  });

  it("names each unwritable directory and its errno", () => {
    const checks = [ok("/state/config"), bad("/state/data"), bad("/state/cache")];
    const msg = formatStateDirWarning(checks, { uid: 1000, stateRoot: "/state", ownerUid: 0 });
    expect(msg).not.toBeNull();
    expect(msg).toContain("/state/data");
    expect(msg).toContain("/state/cache");
    expect(msg).toContain("EACCES");
    // The writable one is never named — a warning that lists working paths reads
    // as noise and hides the two that matter.
    expect(msg).not.toContain("/state/config");
  });

  it("spells out the uid/owner mismatch and a copy-pasteable chown when they differ", () => {
    const msg = formatStateDirWarning([bad("/state/cache")], {
      uid: 1000,
      stateRoot: "/state",
      ownerUid: 0,
    });
    expect(msg).toContain("uid 1000");
    expect(msg).toContain("uid 0");
    // The fix that resolves the Docker bind-mount case, with the running uid
    // filled in so it can be pasted as-is.
    expect(msg).toContain("chown -R 1000:1000");
  });

  it("does not blame ownership when the uid already owns the dir but still can't write", () => {
    // Same uid but unwritable is a mode problem (e.g. 0555), not ownership —
    // suggesting chown would send the operator down the wrong path.
    const msg = formatStateDirWarning([bad("/state/cache")], {
      uid: 1000,
      stateRoot: "/state",
      ownerUid: 1000,
    });
    expect(msg).not.toBeNull();
    expect(msg).not.toContain("owned by");
    expect(msg).not.toContain("chown");
    expect(msg).toContain("permission");
  });

  it("still warns without a chown line where uids do not apply (uid undefined)", () => {
    const msg = formatStateDirWarning([bad("/state/cache", "EPERM")], {
      uid: undefined,
      stateRoot: "/state",
      ownerUid: undefined,
    });
    expect(msg).toContain("/state/cache");
    expect(msg).toContain("EPERM");
    expect(msg).not.toContain("chown");
  });

  it("offers the chown hint when the owner could not be stat-ed but a uid is known", () => {
    const msg = formatStateDirWarning([bad("/state/cache")], {
      uid: 1000,
      stateRoot: "/state",
      ownerUid: undefined,
    });
    expect(msg).toContain("chown -R 1000:1000");
  });
});

describe("checkStateDirsWritable", () => {
  it("returns null when the given dirs can be created and written", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "torlnk-state-ok-"));
    try {
      const dirs = ["config", "data", "cache"].map((d) => path.join(root, d));
      expect(await checkStateDirsWritable({ dirs, stateRoot: root })).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("warns and names the offending path when a dir cannot be created", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "torlnk-state-bad-"));
    try {
      // A regular file where a directory needs to be: mkdir of a child throws
      // ENOTDIR/EEXIST, which is exactly the never-writable shape we must surface.
      const wall = path.join(root, "cache");
      await fs.writeFile(wall, "");
      const dirs = [path.join(wall, "posters")];
      const msg = await checkStateDirsWritable({ dirs, stateRoot: root });
      expect(msg).not.toBeNull();
      expect(msg).toContain(path.join(wall, "posters"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
