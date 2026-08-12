import { useEffect, useRef, useState } from "react";
import type { FetchImpl } from "../../util/net";
import { screenshotsFor } from "../../core/screenshots";
import { renderPosterFile } from "../../util/poster";
import { getScreenshot } from "../../core/screenshotCache";

// undefined = still loading; null = looked up, none available; string[] = rows.
export interface ScreenshotPreview {
  rows: string[] | null | undefined;
}

interface Args {
  // Fetch + render the first screenshot for the selection. Off when the toggle
  // is off or the section isn't adult.
  enabled: boolean;
  source: string | undefined;
  ref: string | undefined;
  // Stable identity of the selection ("" when nothing is selected). Same key ⇒
  // one cached lookup, so repeat visits and re-renders don't re-fetch.
  cacheKey: string;
  posterCols: number;
  posterMaxRows: number;
  fetchImpl?: FetchImpl;
  debounceMs?: number;
}

// Lazily resolves the first screenshot for an adult result and renders it as
// truecolor half-blocks, debounced and cached by `cacheKey`. Mirrors
// useTitlePreview: the screenshot occupies the same poster slot in PreviewPane.
export function useScreenshots(args: Args): ScreenshotPreview {
  const { enabled, source, ref, cacheKey, posterCols, posterMaxRows, fetchImpl, debounceMs = 150 } = args;

  // null = resolved to no screenshot; string[] = rendered rows.
  const rows = useRef(new Map<string, string[] | null>());
  const [, bump] = useState(0);
  // `source`/`ref` are read from refs so the effect can depend only on the
  // stable cacheKey (a fresh render must not restart the debounce).
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const refRef = useRef(ref);
  refRef.current = ref;

  const key = cacheKey ? `${cacheKey}:${posterCols}` : "";

  useEffect(() => {
    if (!enabled || !key || rows.current.has(key)) return;
    let cancelled = false;
    const t = setTimeout(() => {
      const src = sourceRef.current;
      const r = refRef.current;
      if (!src || !r) {
        rows.current.set(key, null);
        bump((n) => n + 1);
        return;
      }
      void screenshotsFor(src, r, { limit: 1, fetchImpl })
        .then(async (shots) => {
          if (cancelled) return;
          const first = shots[0];
          if (!first) {
            rows.current.set(key, null);
            bump((n) => n + 1);
            return;
          }
          // getScreenshot caches the bytes through the SCREENSHOT allowlist (the
          // poster cache would reject these hosts); renderPosterFile half-blocks it.
          const hit = await getScreenshot(first.full, { fetchImpl });
          if (cancelled) return;
          const painted = hit ? await renderPosterFile(hit.path, posterCols, posterMaxRows) : null;
          if (cancelled) return;
          rows.current.set(key, painted ?? null);
          bump((n) => n + 1);
        })
        .catch(() => {
          if (cancelled) return;
          rows.current.set(key, null);
          bump((n) => n + 1);
        });
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [enabled, key, posterCols, posterMaxRows, fetchImpl, debounceMs]);

  return { rows: key ? rows.current.get(key) : undefined };
}
