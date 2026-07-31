import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { StoreContext, type Store } from "../store";
import { Accounts, type DebridAccountProps } from "./Accounts";
import type { ReccStatus } from "../../recc/status";
import type { DebridStatus } from "../../integrations/debrid/types";

function storeStub(): Store {
  return { region: "content", section: "accounts" } as unknown as Store;
}

/**
 * A store with the width and height the real pane actually gets. The plain
 * stub leaves both undefined, so the Panel is unconstrained and never has to
 * fit its rows — which is why it can't catch a squashed row.
 */
function sizedStoreStub(listRows: number): Store {
  return {
    region: "content",
    section: "accounts",
    contentWidth: 76,
    listRows,
  } as unknown as Store;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

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
  onClaimRecc: noop,
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

  it("keeps each row's name line separate from its status line when the pane is short", () => {
    // Every provider signed in — five two-line rows, more than a short pane fits.
    const { lastFrame } = render(
      <StoreContext.Provider value={sizedStoreStub(14)}>
        <Accounts
          {...props({
            rutrackerUser: "alice",
            reccConfigured: true,
            reccStatus: { state: "connected", host: "reccd.local:4100" } as ReccStatus,
            omdbConfigured: true,
          })}
        />
      </StoreContext.Provider>,
    );
    const lines = (lastFrame() ?? "").split("\n");

    // A row's homepage must never share a line with that row's status. When Ink
    // squashes the two-line cell onto one row the status overprints the name,
    // producing run-together text like "60d lefte  · real-debrid.com".
    const homepageLine = lines.find((l) => l.includes("real-debrid.com"));
    expect(homepageLine).toBeDefined();
    expect(homepageLine).not.toContain("premium");

    const torboxLine = lines.find((l) => l.includes("torbox.app"));
    expect(torboxLine).toBeDefined();
    expect(torboxLine).not.toContain("pro ");

    // The tails of the overprinted domains, which only appear when a row collapses.
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("lefte");
    expect(frame).not.toContain("youcker.org");
    expect(frame).not.toContain("setmdbapi.com");
  });

  it("truncates a long provider name rather than spilling it over the key hints", () => {
    // reccd has the longest homepage, and the widest hint set (it adds "i import").
    const { lastFrame } = render(
      <StoreContext.Provider value={sizedStoreStub(20)}>
        <Accounts
          {...props({
            reccConfigured: true,
            reccStatus: { state: "connected", host: "reccd.local:4100" } as ReccStatus,
          })}
        />
      </StoreContext.Provider>,
    );
    expect(lastFrame() ?? "").toContain("i import");
  });

  it("scrolls to keep the cursored provider on screen in a pane too short for all of them", async () => {
    const { lastFrame, stdin } = render(
      <StoreContext.Provider value={sizedStoreStub(11)}>
        <Accounts {...props({ omdbConfigured: true })} />
      </StoreContext.Provider>,
    );
    // Not every row fits, so the last one starts off screen.
    expect(lastFrame() ?? "").not.toContain("omdbapi.com");
    // Up from the first row wraps to the last, which must scroll into view.
    stdin.write("[A");
    await flush();
    expect(lastFrame() ?? "").toContain("omdbapi.com");
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

  // Asserting the "c claim" hint pair, not the bare substring "claim": that
  // substring also matches formatReccStatus's own "(unclaimed)" suffix, which
  // would make these assertions pass regardless of whether the hint itself
  // is gated correctly.
  it("offers c to claim an unclaimed reccd account", () => {
    const { lastFrame } = renderAccounts({
      reccConfigured: true,
      reccStatus: { state: "connected", host: "reccd.stream", account: { name: "quiet-heron-4f2a", claimed: false } },
    });
    expect(lastFrame()).toContain("c claim");
  });

  it("does not offer c once the account is claimed", () => {
    const { lastFrame } = renderAccounts({
      reccConfigured: true,
      reccStatus: { state: "connected", host: "reccd.stream", account: { name: "ash", claimed: true } },
    });
    expect(lastFrame()).not.toContain("c claim");
  });

  // A hand-configured self-hosted reccd reports no account. Offering a claim
  // there would promise something the keypress cannot do.
  it("does not offer c when the connection reports no account", () => {
    const { lastFrame } = renderAccounts({
      reccConfigured: true,
      reccStatus: { state: "connected", host: "192.168.0.98:4100" },
    });
    expect(lastFrame()).not.toContain("c claim");
  });

  it("fires onClaimRecc when c is pressed on the reccd row", async () => {
    const onClaimRecc = vi.fn();
    const { lastFrame, stdin } = renderAccounts({
      reccConfigured: true,
      reccStatus: { state: "connected", host: "reccd.stream", account: { name: "quiet-heron-4f2a", claimed: false } },
      onClaimRecc,
    });
    // Move the cursor to the reccd row — it is third, after the two debrid
    // rows and RuTracker. Confirm we actually landed on it (rather than
    // hard-coding the down count) by checking the pointer sits on the reccd
    // line before pressing c.
    stdin.write("\x1b[B");
    await flush();
    stdin.write("\x1b[B");
    await flush();
    stdin.write("\x1b[B");
    await flush();
    const lines = (lastFrame() ?? "").split("\n");
    const reccdLine = lines.find((l) => l.includes("reccd"));
    expect(reccdLine).toContain("❯");
    stdin.write("c");
    await flush();
    expect(onClaimRecc).toHaveBeenCalledTimes(1);
  });

  it("ignores c on a row that cannot be claimed", async () => {
    const onClaimRecc = vi.fn();
    const { stdin } = renderAccounts({ onClaimRecc });
    stdin.write("c"); // cursor starts on a debrid row
    await flush();
    expect(onClaimRecc).not.toHaveBeenCalled();
  });
});
