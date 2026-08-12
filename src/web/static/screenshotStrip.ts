// The proxied thumb/full pairs the adult preview strip mounts. Pure so the
// "what to show" decision is tested; app.ts only creates the <img> nodes.
//
// The browser only ever hits same-origin /api/screenshot — never the raw
// third-party host — so no uploader-controlled URL is ever a live request the
// page makes directly (IP leak, hotlink, mixed content, CSP all avoided).
import type { Shot } from "../wire";

export function screenshotProxyPath(url: string): string {
  return `/api/screenshot?url=${encodeURIComponent(url)}`;
}

export interface StripItem {
  thumbSrc: string;
  fullSrc: string;
}

export function stripItems(shots: Shot[], max: number): StripItem[] {
  return shots.slice(0, max).map((s) => ({
    thumbSrc: screenshotProxyPath(s.thumb),
    fullSrc: screenshotProxyPath(s.full),
  }));
}
