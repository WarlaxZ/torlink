import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { StoreContext, type Store } from "../store";
import { Splash } from "./Splash";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const TAB = "\t";
const ESC = String.fromCharCode(27);

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

function renderSplash(overrides: Partial<Store> = {}) {
  return render(
    <StoreContext.Provider value={storeStub(overrides)}>
      <Splash />
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
