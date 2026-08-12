import { it, expect } from "vitest";
import { screenshotsFor } from "./screenshots";

function router(map: Record<string, string>) {
  return (async (url: string) => {
    const body = map[url];
    return new Response(body ?? "", { status: body === undefined ? 404 : 200 });
  }) as never;
}

it("resolves TPB landings to shots via og:image", async () => {
  const fetchImpl = router({
    "https://apibay.org/t.php?id=42": JSON.stringify({
      descr: "https://trafficimage.club/image/AAA\nhttps://s.starimage.club/image/BBB",
    }),
    "https://trafficimage.club/image/AAA":
      '<meta property="og:image" content="https://trafficimage.club/images/x.jpg">',
    "https://s.starimage.club/image/BBB":
      '<meta property="og:image" content="https://s.starimage.club/images/y.jpg">',
  });
  const shots = await screenshotsFor("TPB", "42", { fetchImpl, limit: 4 });
  expect(shots).toEqual([
    { full: "https://trafficimage.club/images/x.jpg", thumb: "https://trafficimage.club/images/x.md.jpg" },
    { full: "https://s.starimage.club/images/y.jpg", thumb: "https://s.starimage.club/images/y.md.jpg" },
  ]);
});

it("caps TPB landings at the limit", async () => {
  const fetchImpl = router({
    "https://apibay.org/t.php?id=7": JSON.stringify({
      descr:
        "https://trafficimage.club/image/A https://trafficimage.club/image/B " +
        "https://trafficimage.club/image/C",
    }),
    "https://trafficimage.club/image/A": '<meta property="og:image" content="https://trafficimage.club/images/a.jpg">',
    "https://trafficimage.club/image/B": '<meta property="og:image" content="https://trafficimage.club/images/b.jpg">',
    "https://trafficimage.club/image/C": '<meta property="og:image" content="https://trafficimage.club/images/c.jpg">',
  });
  const shots = await screenshotsFor("TPB", "7", { fetchImpl, limit: 2 });
  expect(shots.map((s) => s.full)).toEqual([
    "https://trafficimage.club/images/a.jpg",
    "https://trafficimage.club/images/b.jpg",
  ]);
});

it("reads 1337x direct images from the detail page", async () => {
  const fetchImpl = router({
    "https://1337x.to/torrent/1/x/":
      '<img src="https://imgtraffic.com/1s/a.jpeg"><img src="https://shotcan.com/i/b.jpg">',
  });
  const shots = await screenshotsFor("1337x", "/torrent/1/x/", { fetchImpl, limit: 4 });
  expect(shots.map((s) => s.full)).toEqual([
    "https://imgtraffic.com/1s/a.jpeg",
    "https://shotcan.com/i/b.jpg",
  ]);
});

it("returns [] when nothing resolves", async () => {
  const shots = await screenshotsFor("TPB", "999", { fetchImpl: router({}), limit: 4 });
  expect(shots).toEqual([]);
});

it("returns [] for an empty ref or unknown source", async () => {
  expect(await screenshotsFor("TPB", "", { fetchImpl: router({}), limit: 4 })).toEqual([]);
  expect(await screenshotsFor("RARBG", "1", { fetchImpl: router({}), limit: 4 })).toEqual([]);
});
