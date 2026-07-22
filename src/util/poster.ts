import jpeg from "jpeg-js";
import type { FetchImpl } from "./net";
import { log } from "./logger";

const UP = "▀"; // upper half block: fg paints the top pixel, bg the bottom one

export interface Rgba {
  data: Uint8Array;
  width: number;
  height: number;
}

// Box-average downscale to dstW × dstH. Averaging (rather than nearest) keeps
// small posters from looking jagged.
export function downscale(src: Rgba, dstW: number, dstH: number): Rgba {
  const out = new Uint8Array(dstW * dstH * 4);
  const xRatio = src.width / dstW;
  const yRatio = src.height / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = Math.floor(dy * yRatio);
    const sy1 = Math.max(sy0 + 1, Math.floor((dy + 1) * yRatio));
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.floor(dx * xRatio);
      const sx1 = Math.max(sx0 + 1, Math.floor((dx + 1) * xRatio));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < src.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < src.width; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i]!;
          g += src.data[i + 1]!;
          b += src.data[i + 2]!;
          n++;
        }
      }
      const o = (dy * dstW + dx) * 4;
      out[o] = n ? Math.round(r / n) : 0;
      out[o + 1] = n ? Math.round(g / n) : 0;
      out[o + 2] = n ? Math.round(b / n) : 0;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: dstW, height: dstH };
}

// Pack each pair of pixel rows into one text row: `▀` with the foreground set
// to the top pixel and the background to the bottom pixel. A trailing odd row
// paints its single pixel on the foreground over a default background.
export function halfBlockRows(img: Rgba): string[] {
  const { data, width, height } = img;
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  };
  const rows: string[] = [];
  for (let y = 0; y < height; y += 2) {
    let row = "";
    const hasBottom = y + 1 < height;
    for (let x = 0; x < width; x++) {
      const [tr, tg, tb] = at(x, y);
      if (hasBottom) {
        const [br, bg, bb] = at(x, y + 1);
        row += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m${UP}`;
      } else {
        row += `\x1b[49m\x1b[38;2;${tr};${tg};${tb}m${UP}`;
      }
    }
    rows.push(row + "\x1b[0m");
  }
  return rows;
}

// Fit target pixel dimensions into `cols` wide and `maxRows` text rows while
// preserving the source aspect ratio (1 text row == 2 pixel rows).
function fit(srcW: number, srcH: number, cols: number, maxRows: number): [number, number] {
  let w = Math.max(1, cols);
  let h = Math.max(1, Math.round(w * (srcH / srcW)));
  const maxPx = Math.max(2, maxRows * 2);
  if (h > maxPx) {
    h = maxPx;
    w = Math.max(1, Math.min(cols, Math.round(h * (srcW / srcH))));
  }
  return [w, h];
}

// Decode a JPEG buffer and render it as half-block rows, `cols` wide and no
// taller than `maxRows`. Returns null if the buffer can't be decoded (not a
// JPEG, corrupt) — callers should fall back to a placeholder.
export function renderJpegPoster(buf: Buffer, cols: number, maxRows: number): string[] | null {
  if (cols < 1 || maxRows < 1) return null;
  let decoded: { width: number; height: number; data: Uint8Array };
  try {
    decoded = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 64 });
  } catch {
    return null;
  }
  if (!decoded.width || !decoded.height) return null;
  const [w, h] = fit(decoded.width, decoded.height, cols, maxRows);
  const small = downscale({ data: decoded.data, width: decoded.width, height: decoded.height }, w, h);
  return halfBlockRows(small);
}

// Fetch a poster image and render it. Never throws; returns null on any
// failure (network, non-JPEG, decode error).
export async function fetchPosterRows(
  url: string,
  cols: number,
  maxRows: number,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<string[] | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return renderJpegPoster(buf, cols, maxRows);
  } catch (err) {
    log.debug(`poster fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
