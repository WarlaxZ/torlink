import { describe, it, expect, vi } from "vitest";
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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const flushPlot = (): Promise<void> => new Promise((r) => setTimeout(r, 250));
const ESC = String.fromCharCode(27);

const REC = { imdbId: "tt1", title: "Chernobyl", year: 2019, score: 33.4, reasons: ["highly rated classic"] };
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
  const posterUrl = "https://img.example/poster.jpg";
  const jpg = redJpeg();
  const impl = (async (url: string) => {
    const u = String(url);
    urls.push(u);
    if (u === posterUrl) {
      return { ok: true, status: 200, arrayBuffer: async () => jpg } as unknown as Response;
    }
    const body = u.includes("omdbapi.com")
      ? { Response: "True", Plot: plot, Poster: posterUrl }
      : [REC];
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as FetchImpl;
  return { impl, urls };
}

describe("ForYou", () => {
  it("fetches and renders picks once active", async () => {
    const { impl } = fetchStub();
    const { lastFrame } = render(
      <ForYou reccConfig={CONFIG} visible active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    expect(lastFrame()).toContain("Chernobyl");
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
    expect(submitQuery).toHaveBeenCalledWith("Chernobyl");
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
    expect(onRatePick).toHaveBeenCalledWith("Chernobyl", expect.any(Function));
    // Invoking the provided callback dismisses the pick from the list.
    const onRated = onRatePick.mock.calls[0]![1] as () => void;
    onRated();
    await flush();
    expect(lastFrame()).not.toContain("Chernobyl");
  });

  it("renders the title with the year inline", async () => {
    const { impl } = fetchStub();
    const { lastFrame } = render(
      <ForYou reccConfig={CONFIG} visible active setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flush();
    expect(lastFrame()).toContain("Chernobyl (2019)");
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
    await flushPlot();
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
    await flushPlot();
    const f = lastFrame() ?? "";
    expect(f).toContain("·  Boom."); // inline plot on the selected row
    expect(f).not.toContain("Preview"); // no split pane at 60 cols
  });

  it("shows a Preview pane with the plot and rendered poster on a wide terminal", async () => {
    const { impl, urls } = fetchStubFull("A firefighter investigates.");
    const { lastFrame } = render(
      <ForYou reccConfig={CONFIG} omdbApiKey="KEY" width={96} height={30} visible active
        setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flushPlot();
    const f = lastFrame() ?? "";
    expect(f).toContain("Preview");
    expect(f).toContain("A firefighter investigates.");
    expect(urls.some((u) => u.includes("poster.jpg"))).toBe(true); // poster fetched
    expect(f).toContain("38;2;"); // poster rendered as truecolor half-blocks
  });

  it("toggles the preview pane off and on with 'p'", async () => {
    const { impl } = fetchStubFull("A firefighter investigates.");
    const { stdin, lastFrame } = render(
      <ForYou reccConfig={CONFIG} omdbApiKey="KEY" width={96} height={30} visible active
        setSection={vi.fn()} submitQuery={vi.fn()} fetchImpl={impl} />,
    );
    await flushPlot();
    expect(lastFrame()).toContain("Preview");
    stdin.write("p");
    await flush();
    expect(lastFrame()).not.toContain("Preview");
    stdin.write("p");
    await flush();
    expect(lastFrame()).toContain("Preview");
  });

  it("adds the selected pick to the watchlist on 'w' without dismissing it", async () => {
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
    expect(toggleSavedSearch).toHaveBeenCalledWith("Chernobyl");
    expect(lastFrame()).toContain("Chernobyl"); // stays in the list
  });
});
