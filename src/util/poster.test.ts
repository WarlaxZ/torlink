import { describe, it, expect } from "vitest";
import jpeg from "jpeg-js";
import { halfBlockRows, downscale, renderJpegPoster } from "./poster";

// Build a solid-colour RGBA buffer.
function solid(w: number, h: number, r: number, g: number, b: number) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

describe("halfBlockRows", () => {
  it("packs two pixel rows into one text row of ▀ cells", () => {
    // 2px wide, 2px tall → 1 text row, 2 cells.
    const img = solid(2, 2, 10, 20, 30);
    const rows = halfBlockRows(img);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.match(/▀/g) ?? []).length).toBe(2); // two cells
    expect(rows[0]).toContain("38;2;10;20;30"); // fg = top pixel
    expect(rows[0]).toContain("48;2;10;20;30"); // bg = bottom pixel
    expect(rows[0]!.endsWith("\x1b[0m")).toBe(true); // reset at row end
  });

  it("emits one text row per two pixel rows", () => {
    expect(halfBlockRows(solid(1, 6, 0, 0, 0))).toHaveLength(3);
  });
});

describe("downscale", () => {
  it("resizes to the requested pixel dimensions", () => {
    const out = downscale(solid(8, 8, 100, 100, 100), 4, 3);
    expect(out.width).toBe(4);
    expect(out.height).toBe(3);
    expect(out.data.length).toBe(4 * 3 * 4);
    // A solid image stays that colour after averaging.
    expect(out.data[0]).toBe(100);
  });
});

describe("renderJpegPoster", () => {
  it("decodes a JPEG and renders half-block rows within the size budget", () => {
    const raw = solid(60, 90, 200, 40, 40); // 2:3-ish poster
    const buf = jpeg.encode({ data: Buffer.from(raw.data), width: 60, height: 90 }, 90).data;
    const rows = renderJpegPoster(Buffer.from(buf), 20, 40);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(0);
    expect(rows!.length).toBeLessThanOrEqual(40); // within maxRows
    // Each rendered row is at most `cols` cells wide (▀ per source column).
    const cells = (rows![0]!.match(/▀/g) ?? []).length;
    expect(cells).toBeGreaterThan(0);
    expect(cells).toBeLessThanOrEqual(20);
    expect(rows![0]).toContain("38;2;"); // truecolor output
  });

  it("clamps height to maxRows for a tall image", () => {
    const raw = solid(20, 200, 10, 10, 10);
    const buf = jpeg.encode({ data: Buffer.from(raw.data), width: 20, height: 200 }, 90).data;
    const rows = renderJpegPoster(Buffer.from(buf), 30, 8);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeLessThanOrEqual(8);
  });

  it("returns null for a non-JPEG / undecodable buffer", () => {
    expect(renderJpegPoster(Buffer.from("not a jpeg"), 20, 40)).toBeNull();
  });
});
