import { describe, it, expect } from "vitest";
import path from "node:path";
import { keepMovePlan } from "./streamKeep";

describe("keepMovePlan", () => {
  it("moves the torrent's top-level folder from temp into downloads", () => {
    const plan = keepMovePlan({
      streamDir: "/tmp/torlink-stream-abc",
      torrentName: "Big Buck Bunny",
      downloadDir: "/home/u/Downloads",
    });
    expect(plan.from).toBe(path.join("/tmp/torlink-stream-abc", "Big Buck Bunny"));
    expect(plan.to).toBe(path.join("/home/u/Downloads", "Big Buck Bunny"));
  });
});
