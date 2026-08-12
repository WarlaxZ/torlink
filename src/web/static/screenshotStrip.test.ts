import { it, expect } from "vitest";
import { stripItems } from "./screenshotStrip";

it("proxies through same-origin and caps the count", () => {
  const shots = Array.from({ length: 6 }, (_, i) => ({ thumb: `https://h/t${i}.jpg`, full: `https://h/f${i}.jpg` }));
  const items = stripItems(shots, 4);
  expect(items).toHaveLength(4);
  expect(items[0]!.thumbSrc).toBe("/api/screenshot?url=" + encodeURIComponent("https://h/t0.jpg"));
  expect(items[0]!.fullSrc).toBe("/api/screenshot?url=" + encodeURIComponent("https://h/f0.jpg"));
});

it("is empty for no shots", () => {
  expect(stripItems([], 4)).toEqual([]);
});

it("encodes so a crafted url can't break out of the query param", () => {
  const items = stripItems([{ thumb: "https://h/a.jpg?x=1&y=2", full: "https://h/a.jpg" }], 4);
  expect(items[0]!.thumbSrc).toBe("/api/screenshot?url=" + encodeURIComponent("https://h/a.jpg?x=1&y=2"));
});
