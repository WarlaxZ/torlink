import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "ink-testing-library";
import { StoreContext, type Store } from "../store";
import { Splash } from "./Splash";
import type { FetchImpl } from "../../util/net";
import type { ReccClientConfig } from "../../recc/client";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const TAB = "\t";
const ESC = String.fromCharCode(27);

// Captured BEFORE any fake timers are installed further down this file:
// `setImmediate` is faked too, and ink's React scheduler drains its work
// through a MessageChannel message — a macrotask — so awaiting fake timers
// alone never repaints the frame. Same reasoning as ForYou.test.tsx.
const yieldToLoop = setImmediate;

function storeStub(overrides: Partial<Store> = {}): Store {
  return {
    submitQuery: () => {},
    searchHistory: [],
    quitAll: () => {},
    cols: 80,
    rows: 24,
    debridConfigured: false,
    debridProvider: null,
    debridStatus: null,
    setView: () => {},
    setRegion: () => {},
    ...overrides,
  } as unknown as Store;
}

type SplashProps = { reccConfig?: ReccClientConfig; fetchImpl?: FetchImpl };

function renderSplash(overrides: Partial<Store> = {}, props: SplashProps = {}) {
  return render(
    <StoreContext.Provider value={storeStub(overrides)}>
      <Splash reccConfig={props.reccConfig ?? {}} fetchImpl={props.fetchImpl} />
    </StoreContext.Provider>,
  );
}

describe("Splash", () => {
  it("does not navigate away when the query starts with a shortcut letter", async () => {
    // Regression: typing the first letter of a search (e.g. the "a" of "alex")
    // must not fire a single-key shortcut, because the search field is always
    // focused here and owns every printable keystroke.
    const setView = vi.fn();
    const setRegion = vi.fn();
    const { stdin } = renderSplash({ setView, setRegion });
    await flush();
    stdin.write("a");
    await flush();
    expect(setView).not.toHaveBeenCalled();
    expect(setRegion).not.toHaveBeenCalled();
  });

  it("drops into the sidebar menu on tab", async () => {
    const setView = vi.fn();
    const setRegion = vi.fn();
    const { stdin } = renderSplash({ setView, setRegion });
    await flush();
    stdin.write(TAB);
    await flush();
    expect(setView).toHaveBeenCalledWith("browser");
    expect(setRegion).toHaveBeenCalledWith("sidebar");
  });

  it("submits the typed query on enter", async () => {
    const submitQuery = vi.fn();
    const { stdin } = renderSplash({ submitQuery });
    await flush();
    stdin.write("alex");
    await flush();
    stdin.write("\r");
    await flush();
    expect(submitQuery).toHaveBeenCalledWith("alex");
  });

  it("quits on escape", async () => {
    const quitAll = vi.fn();
    const { stdin } = renderSplash({ quitAll });
    await flush();
    stdin.write(ESC);
    await flush();
    expect(quitAll).toHaveBeenCalledTimes(1);
  });

  it("does not show a stale account name left over from before a provider switch", async () => {
    // debridStatus can lag behind debridProvider in the async window right
    // after a switch (it's revalidated, not swapped instantly). A status from
    // the OLD provider says nothing about the new one, so it must be ignored
    // rather than rendered — the same guard Accounts.tsx and
    // classifyStreamRoute already apply.
    const { lastFrame } = renderSplash({
      debridConfigured: true,
      debridProvider: "realdebrid",
      debridStatus: {
        provider: "torbox",
        username: "stale-torbox-user",
        active: true,
        planLabel: "pro",
        expiresAt: null,
      },
    });
    await flush();
    expect(lastFrame()).not.toContain("stale-torbox-user");
    expect(lastFrame()).toContain("connected");
  });
});

// reccd's replies are injected through the `fetchImpl` prop — the same escape
// hatch ForYou uses — so nothing here dials out.
const SUGGEST_CFG: ReccClientConfig = { reccUrl: "http://recc.invalid:4100", reccToken: "tok" };
const KESTREL = { imdbId: "tt1", title: "Kestrel", year: 2010, type: "movie", matchedAka: null };

// `fetchTitleSuggestions` validates EVERY element and fails the whole reply on
// one bad one, which the hook then renders as an empty list — so `matchedAka` is
// not decoration here, it is what makes the stub a valid reply.
function suggestStub(items: unknown[] = [KESTREL]): { impl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => items } as unknown as Response;
  }) as unknown as FetchImpl;
  return { impl, urls };
}

describe("Splash search suggestions", () => {
  // Escape escalates rather than quitting outright: putting a dropdown away must
  // not be able to close the app, and escape-to-quit must survive the guard.
  it("dismisses the suggestion list on escape rather than quitting", async () => {
    const { impl } = suggestStub();
    const quitAll = vi.fn();
    const { stdin, lastFrame } = renderSplash({ quitAll }, { reccConfig: SUGGEST_CFG, fetchImpl: impl });
    await flush();
    stdin.write("ke");
    // Polls the keystroke -> debounce -> reply -> repaint chain out rather than
    // sleeping a fixed span past it, which loses the race on a loaded machine.
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("Kestrel (2010) · film"), {
      timeout: 5000,
    });

    stdin.write(ESC);
    await vi.waitFor(() => expect(lastFrame() ?? "").not.toContain("Kestrel (2010)"));
    expect(quitAll).not.toHaveBeenCalled();

    // The second escape, with the list gone, still quits.
    stdin.write(ESC);
    await vi.waitFor(() => expect(quitAll).toHaveBeenCalledTimes(1));
  });

  it("still quits on escape with reccd configured and no list open", async () => {
    // Distinct from the plain "quits on escape" above: here the guard exists and
    // is asked about, but nothing has been typed so there is nothing to dismiss.
    const { impl } = suggestStub();
    const quitAll = vi.fn();
    const { stdin } = renderSplash({ quitAll }, { reccConfig: SUGGEST_CFG, fetchImpl: impl });
    await flush();
    stdin.write(ESC);
    await flush();
    expect(quitAll).toHaveBeenCalledTimes(1);
    // No assertion on `urls` here: nothing was typed, so an empty list of
    // requests is not a property any change to this code could break. The
    // request-side negatives live in the fake-timer describe below, where the
    // clock can be run past the debounce to make them exact.
  });

  it("completes on tab with a suggestion available, instead of entering the app", async () => {
    const { impl } = suggestStub();
    const setView = vi.fn();
    const setRegion = vi.fn();
    const { stdin, lastFrame } = renderSplash(
      { setView, setRegion },
      { reccConfig: SUGGEST_CFG, fetchImpl: impl },
    );
    await flush();
    stdin.write("ke");
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("Kestrel (2010) · film"), {
      timeout: 5000,
    });

    stdin.write(TAB);
    // Title AND year — the whole point of canonicalising through a catalog.
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("Kestrel 2010"));
    expect(setView).not.toHaveBeenCalled();
    expect(setRegion).not.toHaveBeenCalled();
    // Accepting suppresses the text just taken, so the list does not reopen on it.
    await vi.waitFor(() => expect(lastFrame() ?? "").not.toContain("Kestrel (2010) · film"));
  });

  it("still enters the app on tab with no suggestions", async () => {
    // reccd configured, but nothing typed — tab behaves exactly as it did
    // before suggestions existed.
    const { impl } = suggestStub();
    const setView = vi.fn();
    const setRegion = vi.fn();
    const { stdin } = renderSplash(
      { setView, setRegion },
      { reccConfig: SUGGEST_CFG, fetchImpl: impl },
    );
    await flush();
    stdin.write(TAB);
    await flush();
    expect(setView).toHaveBeenCalledWith("browser");
    expect(setRegion).toHaveBeenCalledWith("sidebar");
  });

  it("relabels the tab hint from browse to complete while a list is open", async () => {
    const { impl } = suggestStub();
    const { stdin, lastFrame } = renderSplash({}, { reccConfig: SUGGEST_CFG, fetchImpl: impl });
    await flush();
    expect(lastFrame() ?? "").toContain("browse");
    stdin.write("ke");
    await vi.waitFor(() => expect(lastFrame() ?? "").toContain("complete"), { timeout: 5000 });
    expect(lastFrame() ?? "").not.toContain("browse");
  });
});

// The debounce and the `enabled` gate can only be proved EXACTLY under fake
// time: on real timers "no request fired" after a few awaits is unbounded and
// therefore vacuous. Fake timers stay scoped to this describe — the rest of the
// file's `flush` is a real 20ms sleep and would never resolve under them.
describe("Splash suggestion requests", () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  // Let ink's MessageChannel-scheduled render and the fetch promise chain drain
  // without moving the clock.
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
      await new Promise<void>((r) => yieldToLoop(() => r()));
    }
  };
  const tick = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await settle();
  };

  it("fires nothing at all while reccd is unconfigured", async () => {
    const { impl, urls } = suggestStub();
    // No reccUrl. Run the clock a full second past the 250ms debounce, so
    // nothing can still be pending — this is what makes the negative exact.
    const { stdin } = renderSplash({}, { reccConfig: {}, fetchImpl: impl });
    await settle();
    stdin.write("kestrel");
    await tick(1000);
    expect(urls).toHaveLength(0);
  });

  it("waits out the debounce before asking reccd anything", async () => {
    const { impl, urls } = suggestStub();
    const { stdin } = renderSplash({}, { reccConfig: SUGGEST_CFG, fetchImpl: impl });
    await settle();
    stdin.write("ke");
    await tick(200); // inside the 250ms window
    expect(urls).toHaveLength(0);
    await tick(100); // past it
    expect(urls).toHaveLength(1);
  });

  it("collapses a burst of keystrokes into one request for the final text", async () => {
    const { impl, urls } = suggestStub();
    const { stdin } = renderSplash({}, { reccConfig: SUGGEST_CFG, fetchImpl: impl });
    await settle();
    for (const ch of "kestrel") {
      stdin.write(ch);
      await tick(40); // seven keystrokes, all inside one debounce window
    }
    await tick(1000);
    // Exactly one request for the text finally in the box, not an intermediate
    // prefix. (A `toBeLessThan(7)` used to sit above this: it passed at zero
    // calls and said nothing that toHaveLength(1) does not say exactly.)
    expect(urls).toHaveLength(1);
    // Anchored on the trailing separator: "q=kestrel" alone is also satisfied by
    // "q=kestrelXYZ", and both stubs in this file ignore the URL and always
    // answer [KESTREL] — so this assertion is the only thing pinning what was
    // actually asked.
    expect(urls[0]).toContain("q=kestrel&");
  });
});
