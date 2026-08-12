import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getScreenshot } from "./screenshotCache";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const okFetch = (body: Buffer) =>
  (async () => new Response(body as unknown as BodyInit, { status: 200, headers: { "content-type": "image/jpeg" } })) as never;

it("caches an allowed jpeg screenshot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss-"));
  const hit = await getScreenshot("https://imgtraffic.com/1s/a.jpeg", { dir, fetchImpl: okFetch(JPEG) });
  expect(hit).not.toBeNull();
  expect(hit!.bytes).toBe(JPEG.length);
});

it("accepts a png too", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss-"));
  const hit = await getScreenshot("https://shotcan.com/i/b.png", { dir, fetchImpl: okFetch(PNG) });
  expect(hit).not.toBeNull();
});

it("refuses a non-allowlisted host", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss-"));
  const hit = await getScreenshot("https://evil.example/a.jpg", { dir, fetchImpl: okFetch(JPEG) });
  expect(hit).toBeNull();
});

it("rejects an HTML body on an allowed host", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ss-"));
  const html = Buffer.from("<html>nope</html>");
  const hit = await getScreenshot("https://imgtraffic.com/1s/a.jpeg", { dir, fetchImpl: okFetch(html) });
  expect(hit).toBeNull();
});
