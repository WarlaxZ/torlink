import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPreviewController,
  imdbSearchUrl,
  posterPath,
  previewCopy,
  PREVIEW_DEBOUNCE_MS,
  type PreviewEffects,
  type PreviewState,
  type PublicTitleMeta,
} from "./previewModel";

const OK: PublicTitleMeta = {
  status: "ok",
  imdbId: "tt1727587",
  plot: "A lonely young woman befriends a dragon.",
  posterUrl: "https://m.media-amazon.com/images/M/sintel.jpg",
  parsed: { title: "Sintel", year: 2010, type: "movie" },
};

/**
 * A controller wired to a fake clock and a counting fetch. `schedule`/`cancel`
 * are the injected seams precisely so this can be driven a keypress at a time.
 */
function harness(answer: (release: string) => PublicTitleMeta | null = () => OK) {
  const rendered: PreviewState[] = [];
  const asked: string[] = [];
  const fx: PreviewEffects = {
    fetch: (release) => {
      asked.push(release);
      return Promise.resolve(answer(release));
    },
    schedule: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    cancel: (handle) => clearTimeout(handle),
    render: (state) => rendered.push(state),
  };
  return { controller: createPreviewController(fx), rendered, asked };
}

describe("createPreviewController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it("fires one lookup for fifty results arrowed through", async () => {
    // MUTATION GUARD (the preview firing per-result instead of debounced).
    // A free OMDb key is capped at 1,000 lookups a day; holding the down arrow
    // through a result list without this spends fifty of them on previews
    // nobody looked at. Delete the debounce and `asked` is 50 here.
    const { controller, asked } = harness();
    for (let i = 0; i < 50; i++) {
      controller.select(`Release.${i}.1080p`, "Movies");
      // Faster than the debounce, as a held key is.
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS - 50);
    }
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);

    expect(asked).toEqual(["Release.49.1080p"]);
  });

  it("does not ask before the debounce has elapsed", async () => {
    const { controller, asked } = harness();
    controller.select("Sintel.2010", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS - 1);
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(asked).toEqual(["Sintel.2010"]);
  });

  it("shows the release name while it waits, then the answer", async () => {
    const { controller, rendered } = harness();
    controller.select("Sintel.2010", "Movies");
    expect(rendered).toEqual([{ kind: "loading", release: "Sintel.2010" }]);
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    expect(rendered.at(-1)).toEqual({ kind: "ready", release: "Sintel.2010", meta: OK });
  });

  it("serves a repeat selection from cache, with no timer and no request", async () => {
    const { controller, rendered, asked } = harness();
    controller.select("Sintel.2010", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    controller.select("Other.2011", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);

    rendered.length = 0;
    controller.select("Sintel.2010", "Movies");
    // Synchronous: no "loading" frame at all.
    expect(rendered).toEqual([{ kind: "ready", release: "Sintel.2010", meta: OK }]);
    expect(asked).toEqual(["Sintel.2010", "Other.2011"]);
  });

  it("re-selecting the row already shown does nothing", async () => {
    // The results list is rebuilt on every snapshot frame — up to 23 per search
    // — and each rebuild re-asserts the selection. Without this the debounce
    // restarts every frame and a preview never resolves mid-search.
    const { controller, rendered, asked } = harness();
    controller.select("Sintel.2010", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    rendered.length = 0;
    for (let i = 0; i < 23; i++) controller.select("Sintel.2010", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    expect(rendered).toEqual([]);
    expect(asked).toEqual(["Sintel.2010"]);
  });

  it("treats the same release in a different tab as a different lookup", async () => {
    // "TV" and "Movies" send different hints to OMDb, so they are genuinely
    // different questions with different answers.
    const { controller, asked } = harness();
    controller.select("Show.S01E01", "TV");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    controller.select("Show.S01E01", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    expect(asked).toHaveLength(2);
  });

  it("drops a late answer for a row that has been left", async () => {
    // Typed through a holder: TS narrows a plain `let` assigned only inside a
    // callback to `never` at the read site below.
    const slot: { resolve: ((meta: PublicTitleMeta) => void) | null } = { resolve: null };
    const rendered: PreviewState[] = [];
    const fx: PreviewEffects = {
      fetch: (name) =>
        name === "Slow"
          ? new Promise<PublicTitleMeta>((resolve) => {
              slot.resolve = resolve;
            })
          : Promise.resolve(OK),
      schedule: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      cancel: (handle) => clearTimeout(handle),
      render: (state) => rendered.push(state),
    };
    const controller = createPreviewController(fx);

    controller.select("Slow", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    controller.select("Fast", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    expect(rendered.at(-1)).toMatchObject({ kind: "ready", release: "Fast" });

    // The slow one lands now, for a row nobody is looking at any more.
    slot.resolve?.({ status: "error", error: "nope" });
    await vi.advanceTimersByTimeAsync(0);
    expect(rendered.at(-1)).toMatchObject({ kind: "ready", release: "Fast" });
  });

  it("hides the pane for a null selection and cancels a pending lookup", async () => {
    const { controller, rendered, asked } = harness();
    controller.select("Sintel.2010", "Movies");
    controller.select(null, "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS * 4);
    expect(asked).toEqual([]);
    expect(rendered.at(-1)).toEqual({ kind: "hidden" });
  });

  it("turns a transport failure into an honest message, not a hung spinner", async () => {
    const { controller, rendered } = harness(() => null);
    controller.select("Sintel.2010", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    const last = rendered.at(-1);
    expect(last?.kind).toBe("ready");
    if (last?.kind !== "ready") throw new Error("unreachable");
    expect(last.meta.status).toBe("error");
  });

  it("does not cache a transport failure", async () => {
    let fail = true;
    const { controller, asked } = harness(() => (fail ? null : OK));
    controller.select("Sintel.2010", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    fail = false;
    controller.select("Other", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    controller.select("Sintel.2010", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    // Asked again: a second of downtime must not pin "couldn't reach the
    // server" to this title for the life of the page.
    expect(asked).toEqual(["Sintel.2010", "Other", "Sintel.2010"]);
  });

  it("reset empties the cache and hides the pane", async () => {
    const { controller, rendered, asked } = harness();
    controller.select("Sintel.2010", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    controller.reset();
    expect(rendered.at(-1)).toEqual({ kind: "hidden" });
    controller.select("Sintel.2010", "Movies");
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
    expect(asked).toEqual(["Sintel.2010", "Sintel.2010"]);
  });
});

describe("previewCopy", () => {
  it("prefers the server's parsed title over the raw release name", () => {
    const copy = previewCopy("Sintel.2010.1080p.BluRay.x264-GROUP", OK);
    expect(copy.heading).toBe("Sintel");
    expect(copy.sub).toBe("2010");
    expect(copy.body).toBe("A lonely young woman befriends a dragon.");
    expect(copy.imdbUrl).toBe("https://www.imdb.com/title/tt1727587/");
    expect(copy.posterUrl).toBe("https://m.media-amazon.com/images/M/sintel.jpg");
  });

  it("falls back to the release name when nothing parsed", () => {
    const copy = previewCopy("noise.1080p.x265", { status: "error", error: "no title in that release name" });
    expect(copy.heading).toBe("noise.1080p.x265");
    expect(copy.posterUrl).toBeNull();
  });

  it("says how to fix a missing key rather than looking broken", () => {
    const copy = previewCopy("Sintel.2010", { status: "no-key", parsed: { title: "Sintel", year: 2010, type: "movie" } });
    expect(copy.body).toContain("OMDb API key");
    expect(copy.posterNote).toBe("No OMDb key");
    expect(copy.posterUrl).toBeNull();
  });

  it("reports an OMDb miss as a fact about the title", () => {
    const copy = previewCopy("Sintel.2010", { status: "error", error: "Movie not found!" });
    expect(copy.body).toBe("No match on OMDb (Movie not found!).");
    expect(copy.posterUrl).toBeNull();
  });

  it("degrades a poster-less hit to the placeholder, never a broken image", () => {
    const copy = previewCopy("Sintel.2010", {
      status: "ok",
      imdbId: "tt1727587",
      plot: "Something.",
      posterUrl: null,
    });
    expect(copy.posterUrl).toBeNull();
    expect(copy.posterNote).toBe("No poster");
  });

  it("offers an IMDb search when no id resolved, never a guessed title page", () => {
    const copy = previewCopy("Sintel.2010", {
      status: "ok",
      imdbId: null,
      plot: null,
      posterUrl: null,
      parsed: { title: "Sintel", year: 2010, type: "movie" },
    });
    expect(copy.imdbUrl).toBe("https://www.imdb.com/find/?q=Sintel%202010&s=tt");
    expect(copy.body).toContain("no plot");
  });
});

describe("posterPath / imdbSearchUrl", () => {
  it("routes a poster through /api/poster rather than straight to the CDN", () => {
    // Direct would leak the user's IP and referer to Amazon on every preview.
    expect(posterPath("https://m.media-amazon.com/a b.jpg")).toBe(
      "/api/poster?url=https%3A%2F%2Fm.media-amazon.com%2Fa%20b.jpg",
    );
  });

  it("escapes a title into the IMDb search", () => {
    expect(imdbSearchUrl("Fast & Furious", null)).toBe(
      "https://www.imdb.com/find/?q=Fast%20%26%20Furious&s=tt",
    );
  });
});
