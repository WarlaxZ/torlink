import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "ink-testing-library";
import jpeg from "jpeg-js";
import { ForYou } from "./ForYou";
import type { FetchImpl } from "../../util/net";

// A tiny solid-red JPEG, used to exercise the full poster pipeline.
function redJpeg(): Buffer {
  const w = 12, h = 18;
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 220; data[i * 4 + 3] = 255; }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

const openUrl = vi.fn(async (_url: string) => true);
vi.mock("../../util/openUrl", () => ({
  openUrl: (url: string) => openUrl(url),
  imdbTitleUrl: (id: string) => `https://www.imdb.com/title/${id}/`,
}));

// No wall-clock sleeps. `advanceTimersByTimeAsync` is the load-bearing part:
// unlike the sync form it awaits between timers, which lets ink's React
// scheduler drain its MessageChannel macrotask — so passive effects, the
// recommendations fetch and the re-render all settle under fake time.
//
// A fixed real-time sleep used to stand here, and it lost the race on a loaded
// CI runner: the keypress landed before the picks existed, `selectedItem` was
// undefined, and the handler silently did nothing.
// Captured before fake timers are installed: `setImmediate` here is a yield to
// the real event loop, not a wall-clock sleep. ink's React scheduler drains its
// work through a MessageChannel message — a macrotask — and awaiting fake
// timers only drains microtasks, so without this the frame never repaints.
const yieldToLoop = setImmediate;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) {
    await vi.advanceTimersByTimeAsync(25);
    await new Promise<void>((r) => yieldToLoop(() => r()));
  }
};
const ESC = String.fromCharCode(27);

const REC = { imdbId: "tt1", title: "Windmere", year: 2019, score: 33.4, reasons: ["highly rated classic"] };
const CONFIG = { reccUrl: "http://host:4100", reccToken: "tok" };

function fetchStub(): { impl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => [REC] } as unknown as Response;
  }) as unknown as FetchImpl;
  return { impl, urls };
}

// Serves reccd's list on the recommendations URL and an OMDb plot on omdbapi.com.
function fetchStubWithPlot(plot: string): { impl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(String(url));
    const body = String(url).includes("omdbapi.com")
      ? { Response: "True", Plot: plot }
      : [REC];
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as FetchImpl;
  return { impl, urls };
}

// Serves the reccd list, an OMDb record with a plot + poster URL, and the
// poster image bytes themselves — the full preview pipeline.
function fetchStubFull(plot: string): { impl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  // Must be a host in the poster cache's allowlist (see core/posterCache): a
  // fictional host is refused before any fetch, so the preview would never
  // render. Amazon's CDN is also what OMDb actually returns in production.
  const posterUrl = "https://m.media-amazon.com/poster.jpg";
  const jpg = redJpeg();
  const impl = (async (url: string) => {
    const u = String(url);
    urls.push(u);
    if (u === posterUrl) {
      // Real responses always carry headers; the poster cache reads
      // content-length off them to reject oversized bodies early.
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(jpg.length) }),
        arrayBuffer: async () => jpg,
      } as unknown as Response;
    }
    const body = u.includes("omdbapi.com")
      ? { Response: "True", Plot: plot, Poster: posterUrl }
      : [REC];
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as FetchImpl;
  return { impl, urls };
}

describe("ForYou", () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("fetches and renders picks once active", async () => {
    const { impl } = fetchStub();
    const { lastFrame } = render(
      <ForYou reccConfig={CONFIG} visible active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    expect(lastFrame()).toContain("Windmere");
    expect(lastFrame()).toContain("2019");
  });

  it("shows a setup hint when reccUrl is unset", async () => {
    const { impl } = fetchStub();
    const { lastFrame } = render(
      <ForYou reccConfig={{}} visible active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    expect(lastFrame()).toContain("Accounts");
  });

  it("cycles the type filter with 't' and refetches", async () => {
    const { impl, urls } = fetchStub();
    const { stdin } = render(
      <ForYou reccConfig={CONFIG} visible active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    stdin.write("t");
    await flush();
    expect(urls.some((u) => u.includes("type=movie"))).toBe(true);
  });

  it("searches the selected title on enter", async () => {
    const { impl } = fetchStub();
    const setSection = vi.fn();
    const submitQuery = vi.fn();
    const { stdin } = render(
      <ForYou reccConfig={CONFIG} visible active setSection={setSection} submitQuery={submitQuery} fetchImpl={impl} />,
    );
    await flush();
    stdin.write("\r");
    await flush();
    expect(submitQuery).toHaveBeenCalledWith("Windmere");
    expect(setSection).toHaveBeenCalledWith("all");
  });

  it("fetches exactly once on first activation", async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => [REC] } as unknown as Response;
    }) as unknown as FetchImpl;
    render(<ForYou reccConfig={CONFIG} visible active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />);
    await flush();
    expect(calls).toBe(1);
  });

  it("shows an error when the fetch fails", async () => {
    const impl = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as FetchImpl;
    const { lastFrame } = render(
      <ForYou reccConfig={CONFIG} visible active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    expect(lastFrame()).toContain("unavailable");
  });

  it("suppresses global shortcuts by setting captureMode to 'text' when the genre prompt opens", async () => {
    const { impl } = fetchStub();
    const setCaptureMode = vi.fn();
    const { stdin } = render(
      <ForYou
        reccConfig={CONFIG}
        visible
        active
        setSection={vi.fn()}
        submitQuery={vi.fn()}
        setCaptureMode={setCaptureMode}
        fetchImpl={impl}
      />,
    );
    await flush();
    stdin.write("g");
    await flush();
    expect(setCaptureMode).toHaveBeenCalledWith("text");
  });

  it("restores captureMode to 'none' when the genre prompt is cancelled", async () => {
    const { impl } = fetchStub();
    const setCaptureMode = vi.fn();
    const { stdin } = render(
      <ForYou
        reccConfig={CONFIG}
        visible
        active
        setSection={vi.fn()}
        submitQuery={vi.fn()}
        setCaptureMode={setCaptureMode}
        fetchImpl={impl}
      />,
    );
    await flush();
    stdin.write("g");
    await flush();
    stdin.write(ESC);
    await flush();
    expect(setCaptureMode).toHaveBeenCalledWith("none");
  });

  it("opens the rate prompt for the selected pick on 'f' and dismisses it when rated", async () => {
    const { impl } = fetchStub();
    const onRatePick = vi.fn();
    const { stdin, lastFrame } = render(
      <ForYou
        reccConfig={CONFIG}
        visible
        active
        setSection={vi.fn()}
        submitQuery={vi.fn()}
        onRatePick={onRatePick}
        toggleSavedSearch={vi.fn()}
        fetchImpl={impl}
      />,
    );
    await flush();
    stdin.write("f");
    await flush();
    expect(onRatePick).toHaveBeenCalledWith("Windmere", expect.any(Function));
    // Invoking the provided callback dismisses the pick from the list.
    const onRated = onRatePick.mock.calls[0]![1] as () => void;
    onRated();
    await flush();
    expect(lastFrame()).not.toContain("Windmere");
  });

  it("renders the title with the year inline", async () => {
    const { impl } = fetchStub();
    const { lastFrame } = render(
      <ForYou reccConfig={CONFIG} visible active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    expect(lastFrame()).toContain("Windmere (2019)");
  });

  it("opens the selected pick's IMDb page on 'i'", async () => {
    openUrl.mockClear();
    const { impl } = fetchStub();
    const { stdin } = render(
      <ForYou reccConfig={CONFIG} visible active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    stdin.write("i");
    await flush();
    expect(openUrl).toHaveBeenCalledWith("https://www.imdb.com/title/tt1/");
  });

  it("toggles the reason tags off and on with 'b'", async () => {
    const { impl } = fetchStub();
    const { stdin, lastFrame } = render(
      <ForYou reccConfig={CONFIG} visible active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    expect(lastFrame()).toContain("highly rated classic");
    stdin.write("b");
    await flush();
    expect(lastFrame()).not.toContain("highly rated classic");
    expect(lastFrame()).toContain("reasons hidden");
    stdin.write("b");
    await flush();
    expect(lastFrame()).toContain("highly rated classic");
  });

  it("does not fetch a plot when no OMDb key is configured", async () => {
    const { impl, urls } = fetchStubWithPlot("A nuclear disaster.");
    render(<ForYou reccConfig={CONFIG} visible active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />);
    // No key ⇒ the lookup never even schedules. Fake time makes this negative
    // assertion exact rather than hopeful: run the clock a full second past the
    // 150ms debounce (see useTitlePreview) and nothing can still be pending.
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(urls.some((u) => u.includes("omdbapi.com"))).toBe(false);
  });

  // The test terminal is 100 cols, so the preview pane only appears below when
  // width leaves room; 60 keeps it hidden, 96 shows it.
  it("shows the plot inline on a narrow terminal (no preview pane)", async () => {
    const { impl } = fetchStubWithPlot("Boom.");
    const { lastFrame } = render(
      <ForYou reccConfig={CONFIG} omdbApiKey="KEY" width={60} visible active
        setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("·  Boom."), { timeout: 5000 });
    expect(lastFrame() ?? "").not.toContain("Preview"); // no split pane at 60 cols
  });

  it("shows a Preview pane with the plot and rendered poster on a wide terminal", async () => {
    const { impl, urls } = fetchStubFull("A firefighter investigates.");
    const { lastFrame } = render(
      <ForYou reccConfig={CONFIG} omdbApiKey="KEY" width={96} height={30} visible active
        setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    // Poll until the whole debounce → metadata → poster chain has settled; this
    // resolves the moment it's ready rather than sleeping a fixed, CI-fragile span.
    await vi.waitFor(
      () => {
        const f = lastFrame() ?? "";
        expect(f).toContain("Preview");
        expect(f).toContain("A firefighter investigates."); // plot
        expect(urls.some((u) => u.includes("poster.jpg"))).toBe(true); // poster fetched
        expect(f).toContain("38;2;"); // poster rendered as truecolor half-blocks
      },
      { timeout: 5000 },
    );
  });

  it("toggles the preview pane off and on with 'p'", async () => {
    const { impl } = fetchStubFull("A firefighter investigates.");
    const { stdin, lastFrame } = render(
      <ForYou reccConfig={CONFIG} omdbApiKey="KEY" width={96} height={30} visible active
        setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain("Preview"), { timeout: 5000 });
    stdin.write("p");
    await vi.waitFor(() => expect(lastFrame()).not.toContain("Preview"));
    stdin.write("p");
    await vi.waitFor(() => expect(lastFrame()).toContain("Preview"));
  });

  it("saves the selected pick as a search on 'w' without dismissing it", async () => {
    const { impl } = fetchStub();
    const toggleSavedSearch = vi.fn();
    const { stdin, lastFrame } = render(
      <ForYou
        reccConfig={CONFIG}
        visible
        active
        setSection={vi.fn()}
        submitQuery={vi.fn()}
        onRatePick={vi.fn()}
        toggleSavedSearch={toggleSavedSearch}
        fetchImpl={impl}
      />,
    );
    await flush();
    stdin.write("w");
    await flush();
    expect(toggleSavedSearch).toHaveBeenCalledWith("Windmere");
    expect(lastFrame()).toContain("Windmere"); // stays in the list
  });
});
