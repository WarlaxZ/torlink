import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { StoreContext, type Store } from "../store";
import { Settings, type DebridAccountProps } from "./Settings";
import type { ReccStatus } from "../../recc/status";
import type { DebridStatus } from "../../integrations/debrid/types";
import { defaultConfig, type Config } from "../../config/config";

function storeStub(config: Partial<Config> = {}, adultEnabled = false): Store {
  return {
    region: "content",
    section: "settings",
    // Tall enough that all settings and account rows are on screen at once —
    // the windowing itself is exercised by the Accounts scroll behaviour this
    // pane inherited; here we just want to assert on the full list.
    contentWidth: 76,
    listRows: 60,
    adultEnabled,
    config: { ...defaultConfig, ...config },
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

function debridProps(): DebridAccountProps[] {
  return [
    { provider: "realdebrid", token: "rd_live_xxx", status: RD_STATUS, onManage: noop, onSignOut: noop },
    { provider: "torbox", token: "", status: null, onManage: noop, onSignOut: noop },
  ];
}

const baseProps = {
  // account props
  debrid: debridProps(),
  activeDebrid: "realdebrid" as DebridAccountProps["provider"] | null,
  onSetActiveDebrid: noop,
  rutrackerUser: undefined as string | undefined,
  reccConfigured: false,
  reccStatus: null as ReccStatus | null,
  reccEnvOverride: false,
  streamActive: false,
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
  // settings dispatch
  onEditFolder: noop,
  onEditSources: noop,
  onEditQuality: noop,
  onEditDns: noop,
  onEditTrackers: noop,
  onEditLimits: noop,
  onEditVpn: noop,
  onEditPlayer: noop,
  onEditCastDevice: noop,
  onEditCastHost: noop,
  onToggleAdult: noop,
  onToggleProxy: noop,
  dnsEnvOverride: false,
  playerEnvOverride: false,
  adultEnvOverride: false,
  castDeviceEnvOverride: false,
  castHostEnvOverride: false,
};

function props(over: Partial<typeof baseProps> = {}) {
  return { ...baseProps, ...over };
}

function renderSettings(over: Partial<typeof baseProps> = {}, config: Partial<Config> = {}, adultEnabled = false) {
  return render(
    <StoreContext.Provider value={storeStub(config, adultEnabled)}>
      <Settings {...props(over)} />
    </StoreContext.Provider>,
  );
}

describe("Settings", () => {
  it("lists the settings rows with their current values", () => {
    const frame = renderSettings({}, { downloadDir: "/media/dl", trackers: ["udp://t"] }).lastFrame() ?? "";
    expect(frame).toContain("Download folder");
    expect(frame).toContain("/media/dl");
    expect(frame).toContain("Sources");
    expect(frame).toContain("Playback quality");
    expect(frame).toContain("Custom DNS");
    expect(frame).toContain("Extra trackers");
    expect(frame).toContain("Transfer limits");
    expect(frame).toContain("VPN kill switch");
    expect(frame).toContain("Cast device");
    expect(frame).toContain("Cast host");
    expect(frame).toContain("Media player");
    expect(frame).toContain("Adult content");
    expect(frame).toContain("Relay debrid streams");
  });

  it("lists the account rows and marks the active debrid provider", () => {
    const frame = renderSettings().lastFrame() ?? "";
    expect(frame).toContain("Real-Debrid");
    expect(frame).toContain("TorBox");
    expect(frame).toContain("RuTracker");
    expect(frame).toContain("reccd");
    expect(frame).toContain("OMDb");
    expect(frame).toContain("active");
  });

  it("opens the folder editor when ↵ is pressed on the first row", async () => {
    const onEditFolder = vi.fn();
    const { stdin } = renderSettings({ onEditFolder });
    stdin.write("\r");
    await flush();
    expect(onEditFolder).toHaveBeenCalledTimes(1);
  });

  it("opens the account editor when ↵ is pressed on the last row (wrapping up from the top)", async () => {
    const onManageOmdb = vi.fn();
    const { lastFrame, stdin } = renderSettings({ onManageOmdb, omdbConfigured: true });
    stdin.write("\x1b[A"); // up from row 0 wraps to the last row — OMDb
    await flush();
    const pointerLine = (lastFrame() ?? "").split("\n").find((l) => l.includes("OMDb"));
    expect(pointerLine).toContain("❯");
    stdin.write("\r");
    await flush();
    expect(onManageOmdb).toHaveBeenCalledTimes(1);
  });

  it("signs out an account with x, but a settings row never fires it", async () => {
    const onSignOutOmdb = vi.fn();
    const onEditFolder = vi.fn();
    const { stdin } = renderSettings({ onSignOutOmdb, onEditFolder, omdbConfigured: true });
    // x on the folder row (row 0) must do nothing — settings rows have no sign-out.
    stdin.write("x");
    await flush();
    expect(onSignOutOmdb).not.toHaveBeenCalled();
    // Move to OMDb (wrap up) and sign out.
    stdin.write("\x1b[A");
    await flush();
    stdin.write("x");
    await flush();
    expect(onSignOutOmdb).toHaveBeenCalledTimes(1);
  });

  it("shows the adult toggle state and notes an env override when locked", () => {
    const on = renderSettings({}, {}, true).lastFrame() ?? "";
    expect(on).toContain("Adult content");
    expect(on).toContain("on");
    const locked = renderSettings({ adultEnvOverride: true }).lastFrame() ?? "";
    expect(locked).toContain("env");
  });

  it("shows the media player as auto-detect when unset", () => {
    const frame = renderSettings().lastFrame() ?? "";
    expect(frame).toContain("auto-detect");
  });
});
