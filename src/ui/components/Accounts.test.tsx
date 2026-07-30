import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StoreContext, type Store } from "../store";
import { Accounts, type DebridAccountProps } from "./Accounts";
import type { ReccStatus } from "../../recc/status";
import type { DebridStatus } from "../../integrations/debrid/types";

function storeStub(): Store {
  return { region: "content", section: "accounts" } as unknown as Store;
}

const noop = () => {};

const RD_STATUS: DebridStatus = {
  provider: "realdebrid",
  username: "alice",
  active: true,
  planLabel: "premium",
  expiresAt: null,
};

const TB_STATUS: DebridStatus = {
  provider: "torbox",
  username: "alice",
  active: true,
  planLabel: "pro",
  expiresAt: null,
};

function debridProps() {
  return [
    {
      provider: "realdebrid" as const,
      token: "rd_live_xxx",
      status: RD_STATUS,
      onManage: noop,
      onSignOut: noop,
    },
    {
      provider: "torbox" as const,
      token: "tb_live_xxx",
      status: TB_STATUS,
      onManage: noop,
      onSignOut: noop,
    },
  ] satisfies DebridAccountProps[];
}

function props(overrides: Partial<typeof baseProps> = {}) {
  return { ...baseProps, ...overrides };
}

const baseProps = {
  debrid: debridProps(),
  activeDebrid: "realdebrid" as DebridAccountProps["provider"] | null,
  onSetActiveDebrid: noop,
  rutrackerUser: undefined as string | undefined,
  reccConfigured: false,
  reccStatus: null as ReccStatus | null,
  reccEnvOverride: false,
  onManageRutracker: noop,
  onSignOutRutracker: noop,
  onManageRecc: noop,
  onSignOutRecc: noop,
  onImportRecc: noop,
  omdbConfigured: false,
  omdbEnvOverride: false,
  onManageOmdb: noop,
  onSignOutOmdb: noop,
};

function renderAccounts(overrides: Partial<typeof baseProps> = {}) {
  return render(
    <StoreContext.Provider value={storeStub()}>
      <Accounts {...props(overrides)} />
    </StoreContext.Provider>,
  );
}

describe("Accounts", () => {
  it("lists both debrid providers and marks the active one", () => {
    const { lastFrame } = render(
      <StoreContext.Provider value={storeStub()}>
        <Accounts {...props()} />
      </StoreContext.Provider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Real-Debrid");
    expect(frame).toContain("TorBox");
    expect(frame).toContain("active");
  });

  it("offers the make-active key only on a signed-in provider that is not already active", () => {
    const { lastFrame } = render(
      <StoreContext.Provider value={storeStub()}>
        <Accounts {...props({ activeDebrid: "realdebrid" })} />
      </StoreContext.Provider>,
    );
    expect(lastFrame() ?? "").toContain("a use");
  });

  it("lists RuTracker, reccd and OMDb", () => {
    const frame = renderAccounts().lastFrame() ?? "";
    expect(frame).toContain("RuTracker");
    expect(frame).toContain("reccd");
    expect(frame).toContain("OMDb");
  });

  it("shows the OMDb key as set once configured", () => {
    const frame = renderAccounts({ omdbConfigured: true }).lastFrame() ?? "";
    expect(frame).toContain("Key set");
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
