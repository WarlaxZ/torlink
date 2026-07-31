import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FetchImpl } from "../../util/net";
import { fetchTitleSuggestions, type ReccClientConfig } from "../../recc/client";
import {
  applyReply,
  emptySuggestState,
  isSuggestOpen,
  shouldQueryFor,
  submitTextFor,
  suppressFor,
  topSuggestion,
  SUGGEST_DEBOUNCE_MS,
  SUGGEST_ROWS_TERMINAL,
  type SuggestState,
  type TitleSuggestion,
} from "../../util/titleSuggest";

export interface TitleSuggest {
  /** Already capped at SUGGEST_ROWS_TERMINAL. */
  items: TitleSuggestion[];
  open: boolean;
  /** What tab completes to, or null when there is nothing to complete. */
  completion: string | null;
  /** Escape: close the list, and do not reopen it for the current text. */
  dismiss: () => void;
  /** Tab completed the field — stop asking about the text now in it. */
  accept: (text: string) => void;
}

interface Args {
  reccConfig: ReccClientConfig;
  /** The live draft in the field, not the submitted query. */
  query: string;
  /** False on a pane that is not being edited, so nothing fires off screen. */
  enabled: boolean;
  fetchImpl?: FetchImpl;
  debounceMs?: number;
}

/**
 * Title suggestions from reccd for the terminal's search box, debounced.
 *
 * Modelled on `useTitlePreview`, with one deliberate difference: no cache. That
 * hook caches by a stable selection key because scrolling revisits the same
 * rows; here every keystroke is a different query, so a cache would only grow.
 *
 * State lives here and NOT in `Store`: a `Store` field needs matching entries
 * in `makeStore` (scripts/render-previews-impl.tsx) and `makeTestStore`
 * (src/ui/testHarness.ts) or `npm run previews` and `npm run typecheck` break
 * respectively — the right price for state other panes read, and no other pane
 * reads this.
 */
export function useTitleSuggest(args: Args): TitleSuggest {
  const { reccConfig, query, enabled, fetchImpl, debounceMs = SUGGEST_DEBOUNCE_MS } = args;
  const [state, setState] = useState<SuggestState>(emptySuggestState);
  // `reccConfig` is rebuilt each render by resolveReccConfig, so a fresh object
  // every time; this pins one down that only changes when its fields do, which
  // is what lets the effect below depend on the whole config object correctly
  // (satisfying exhaustive-deps) without re-firing every render. This literal
  // must track every field of `ReccClientConfig` — a field added there and not
  // here is dropped silently, since both fields are optional and TypeScript
  // will not flag the omission.
  const { reccUrl, reccToken } = reccConfig;
  const stableConfig = useMemo(() => ({ reccUrl, reccToken }), [reccUrl, reccToken]);
  // Monotonic, and the reason a slow reply cannot overwrite a fast one. reccd
  // answers a 2-char query in ~311ms and an 8-char one in ~71ms, so
  // out-of-order arrival is the normal case. A ref, not state: bumping it must
  // not itself cause a render.
  const seq = useRef(0);
  // The effect keys on `query`, but must read the *current* suppression latch
  // without listing `state` as a dependency — which would re-run it on every
  // reply and re-fire the request that produced it.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!enabled || !stableConfig.reccUrl) return;
    if (!shouldQueryFor(stateRef.current, query)) {
      // Clear anything on screen for a query too short to ask about, so
      // backspacing out of a search does not leave stale rows behind.
      const s = ++seq.current;
      setState((prev) => applyReply(prev, s, []));
      return;
    }
    let cancelled = false;
    const s = ++seq.current;
    const t = setTimeout(() => {
      void fetchTitleSuggestions(stableConfig, { q: query }, { fetchImpl }).then((res) => {
        if (cancelled) return;
        // Every failure renders as no suggestions. This fires per keystroke, so
        // surfacing the reason would mean an error line per character — and the
        // Accounts pane is where a reccd problem belongs.
        setState((prev) => applyReply(prev, s, res.ok ? res.items : []));
      });
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [enabled, stableConfig, query, fetchImpl, debounceMs]);

  // `seq.current` and not `prev.appliedSeq`: a request fired for the keystroke
  // before this dismiss is still in flight with a HIGHER number than anything
  // applied, and passing the applied one would let its reply reopen the list the
  // user just closed. Escape changes no effect dependency, so the effect's
  // `cancelled` flag never fires — this is the only guard on that path.
  const dismiss = useCallback(() => {
    setState((prev) => suppressFor(prev, query, seq.current));
  }, [query]);

  const accept = useCallback((text: string) => {
    setState((prev) => suppressFor(prev, text, seq.current));
  }, []);

  // Capped here rather than in the fetch: reccd is asked for SUGGEST_LIMIT so
  // both surfaces send it the same question, and the terminal renders fewer.
  const capped: SuggestState = {
    ...state,
    items: enabled ? state.items.slice(0, SUGGEST_ROWS_TERMINAL) : [],
  };
  const items = capped.items;
  const top = topSuggestion(capped);
  return {
    items,
    open: isSuggestOpen(capped),
    completion: top ? submitTextFor(top) : null,
    dismiss,
    accept,
  };
}
