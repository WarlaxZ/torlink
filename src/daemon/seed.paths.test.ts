import { describe, it, expect } from "vitest";
import path from "node:path";

import { seedRootFor } from "./seed";

// seedRootFor resolves against the running platform's path rules, so a POSIX
// literal comes back drive-qualified on Windows ("/srv/media" -> "C:\srv\media")
// and every assertion against one fails there. Build the fixtures natively.
const MEDIA = path.resolve(path.join("srv", "media"));

describe("seedRootFor", () => {
  /*
   * The one calculation that decides whether seeding works or silently
   * re-downloads. A torrent names its own top-level entry, so the client's
   * download directory has to be the content's PARENT: pointed at the content
   * itself it looks for album/album, finds nothing, and fetches a second copy
   * next to the one already on disk.
   */
  it("is the content's parent, never the content", () => {
    expect(seedRootFor(path.join(MEDIA, "album"))).toBe(MEDIA);
    expect(seedRootFor(path.join(MEDIA, "film.mkv"))).toBe(MEDIA);
  });

  it("resolves a relative path before taking the parent", () => {
    expect(path.isAbsolute(seedRootFor("./album"))).toBe(true);
    expect(seedRootFor("./album")).toBe(process.cwd());
  });

  // A trailing slash is what tab-completion gives you for a directory, and it
  // would otherwise make dirname return the directory itself.
  it("is not fooled by a trailing slash", () => {
    expect(seedRootFor(path.join(MEDIA, "album") + path.sep)).toBe(MEDIA);
  });
});
