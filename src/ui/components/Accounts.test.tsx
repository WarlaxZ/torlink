import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StoreContext, type Store } from "../store";
import { Accounts } from "./Accounts";
import type { ReccStatus } from "../../recc/status";

function storeStub(): Store {
  return { region: "content", section: "accounts" } as unknown as Store;
}

const noop = () => {};
const baseProps = {
  rdToken: "",
  rdStatus: null,
  rutrackerUser: undefined as string | undefined,
  reccConfigured: false,
  reccStatus: null as ReccStatus | null,
  reccEnvOverride: false,
  onManageRd: noop,
  onSignOutRd: noop,
  onManageRutracker: noop,
  onSignOutRutracker: noop,
  onManageRecc: noop,
  onSignOutRecc: noop,
};

function renderAccounts(overrides: Partial<typeof baseProps> = {}) {
  return render(
    <StoreContext.Provider value={storeStub()}>
      <Accounts {...baseProps} {...overrides} />
    </StoreContext.Provider>,
  );
}

describe("Accounts", () => {
  it("lists Real-Debrid, RuTracker and reccd", () => {
    const frame = renderAccounts().lastFrame() ?? "";
    expect(frame).toContain("Real-Debrid");
    expect(frame).toContain("RuTracker");
    expect(frame).toContain("reccd");
  });

  it("shows Not configured for reccd when unconfigured", () => {
    expect(renderAccounts().lastFrame() ?? "").toContain("Not configured");
  });

  it("shows the RuTracker username when signed in", () => {
    const frame = renderAccounts({ rutrackerUser: "alice" }).lastFrame() ?? "";
    expect(frame).toContain("alice");
  });

  it("shows connected status when reccd is configured and reachable", () => {
    const frame = renderAccounts({
      reccConfigured: true,
      reccStatus: { state: "connected", host: "192.168.0.98:4100" },
    }).lastFrame() ?? "";
    expect(frame).toContain("Connected");
  });

  it("notes an env override when reccEnvOverride is set", () => {
    const frame = renderAccounts({
      reccConfigured: true,
      reccStatus: { state: "connected", host: "h:4100" },
      reccEnvOverride: true,
    }).lastFrame() ?? "";
    expect(frame).toContain("env override");
  });

  it("shows a warn marker and Unreachable when reccd is configured but unreachable", () => {
    const frame = renderAccounts({
      reccConfigured: true,
      reccStatus: { state: "unreachable", host: "h:4100" },
    }).lastFrame() ?? "";
    expect(frame).toContain("Unreachable");
    expect(frame).toContain("⚠");
  });
});
