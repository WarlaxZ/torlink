import { it, expect } from "vitest";
import { fetchAllowedImageBytes } from "./imageProxy";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
function resp(status: number, body: Buffer | null, headers: Record<string, string> = {}): Response {
  return new Response(body as unknown as BodyInit | null, { status, headers });
}
const allow = (u: string) => new URL(u).hostname === "ok.example";
const acceptJpeg = (b: Buffer) => b.length >= 2 && b[0] === 0xff && b[1] === 0xd8;

it("returns bytes for an allowed, valid image", async () => {
  const fetchImpl = (async () => resp(200, JPEG, { "content-type": "image/jpeg" })) as never;
  const buf = await fetchAllowedImageBytes("https://ok.example/a.jpg", {
    allow, maxBytes: 1000, accept: acceptJpeg, fetchImpl,
  });
  expect(buf).not.toBeNull();
  expect(buf!.length).toBe(JPEG.length);
});

it("rejects a disallowed host without fetching", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return resp(200, JPEG);
  }) as never;
  const buf = await fetchAllowedImageBytes("https://evil.example/a.jpg", {
    allow, maxBytes: 1000, accept: acceptJpeg, fetchImpl,
  });
  expect(buf).toBeNull();
  expect(called).toBe(false);
});

it("refuses a redirect to a disallowed host", async () => {
  const fetchImpl = (async (u: string) =>
    u.includes("ok.example")
      ? resp(302, null, { location: "https://evil.example/a.jpg" })
      : resp(200, JPEG)) as never;
  const buf = await fetchAllowedImageBytes("https://ok.example/a.jpg", {
    allow, maxBytes: 1000, accept: acceptJpeg, fetchImpl,
  });
  expect(buf).toBeNull();
});

it("rejects content that fails the magic-byte check", async () => {
  const html = Buffer.from("<html>not an image</html>");
  const fetchImpl = (async () => resp(200, html, { "content-type": "text/html" })) as never;
  const buf = await fetchAllowedImageBytes("https://ok.example/a.jpg", {
    allow, maxBytes: 1000, accept: acceptJpeg, fetchImpl,
  });
  expect(buf).toBeNull();
});

it("rejects an over-cap body", async () => {
  const big = Buffer.alloc(2000, 0xff);
  big[1] = 0xd8;
  const fetchImpl = (async () => resp(200, big, { "content-type": "image/jpeg" })) as never;
  const buf = await fetchAllowedImageBytes("https://ok.example/a.jpg", {
    allow, maxBytes: 1000, accept: acceptJpeg, fetchImpl,
  });
  expect(buf).toBeNull();
});
