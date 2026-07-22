import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ForYou } from "./ForYou";
import type { FetchImpl } from "../../util/net";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

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
    expect(lastFrame()).toContain("set up");
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
});
