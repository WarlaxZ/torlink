import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StoreContext, type Store } from "../store";
import { Sidebar } from "./Sidebar";
import { DownloadQueue } from "../../download/queue";

function baseStore(): Store {
  // Minimal store stub — only the fields Sidebar reads.
  return {
    section: "all",
    setSection: () => {},
    region: "sidebar",
    setRegion: () => {},
    queue: {
      activeCount: 0,
      seedingCount: 0,
      getItems: () => [],
      on: () => {},
      off: () => {},
    } as unknown as DownloadQueue,
  } as unknown as Store;
}

describe("Sidebar", () => {
  it("lists an Accounts entry in the library group", () => {
    const { lastFrame } = render(
      <StoreContext.Provider value={baseStore()}>
        <Sidebar />
      </StoreContext.Provider>,
    );
    expect(lastFrame() ?? "").toContain("Accounts");
  });
});
