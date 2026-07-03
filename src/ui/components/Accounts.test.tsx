import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StoreContext, type Store } from "../store";
import { Accounts } from "./Accounts";

function storeStub(): Store {
  return { region: "content", section: "accounts" } as unknown as Store;
}

const noop = () => {};
const baseProps = {
  rdToken: "",
  rdStatus: null,
  rutrackerUser: undefined as string | undefined,
  onManageRd: noop,
  onSignOutRd: noop,
  onManageRutracker: noop,
  onSignOutRutracker: noop,
};

function renderAccounts(overrides: Partial<typeof baseProps> = {}) {
  return render(
    <StoreContext.Provider value={storeStub()}>
      <Accounts {...baseProps} {...overrides} />
    </StoreContext.Provider>,
  );
}

describe("Accounts", () => {
  it("lists Real-Debrid and RuTracker", () => {
    const frame = renderAccounts().lastFrame() ?? "";
    expect(frame).toContain("Real-Debrid");
    expect(frame).toContain("RuTracker");
  });

  it("shows signed-out state when no credentials", () => {
    expect(renderAccounts().lastFrame() ?? "").toContain("Not signed in");
  });

  it("shows the RuTracker username when signed in", () => {
    const frame = renderAccounts({ rutrackerUser: "alice" }).lastFrame() ?? "";
    expect(frame).toContain("alice");
  });
});
