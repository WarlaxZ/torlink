import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { CastPrompt } from "./CastPrompt";
import type { CastDevice } from "../../core/cast/discover";

// Ink processes stdin on a tick, so every write needs one before the next write
// or the assertion — the same helper the other prompt tests use.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const DEVICES: CastDevice[] = [
  { id: "abc", name: "Living Room TV", model: "Chromecast", host: "10.0.0.5", port: 8009 },
  { id: "k1", name: "Kitchen display", model: "Google TV Streamer", host: "10.0.0.6", port: 8009 },
];

function setup(over: Partial<Parameters<typeof CastPrompt>[0]> = {}) {
  const onSelect = vi.fn();
  const onAddress = vi.fn();
  const onCancel = vi.fn();
  const r = render(
    <CastPrompt
      width={80}
      devices={DEVICES}
      finding={false}
      onSelect={onSelect}
      onAddress={onAddress}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { ...r, onSelect, onAddress, onCancel };
}

describe("CastPrompt", () => {
  it("lists devices with their models", () => {
    const { lastFrame } = setup();
    expect(lastFrame()).toContain("Living Room TV");
    expect(lastFrame()).toContain("Kitchen display");
    expect(lastFrame()).toContain("Google TV Streamer");
  });

  it("selects the highlighted device on enter", async () => {
    const { stdin, onSelect } = setup();
    stdin.write("\r");
    await flush();
    expect(onSelect).toHaveBeenCalledWith(DEVICES[0]);
  });

  it("moves the cursor before selecting", async () => {
    const { stdin, onSelect } = setup();
    stdin.write("[B"); // down
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSelect).toHaveBeenCalledWith(DEVICES[1]);
  });

  it("wraps the cursor, so up from the first row reaches the last", async () => {
    const { stdin, onSelect } = setup();
    stdin.write("[A"); // up
    await flush();
    stdin.write("\r");
    await flush();
    expect(onSelect).toHaveBeenCalledWith(DEVICES[1]);
  });

  it("says it is looking while discovery runs, and offers no address field yet", () => {
    const { lastFrame } = setup({ devices: [], finding: true });
    expect(lastFrame()).toMatch(/Looking for/i);
    // No field while there is still hope: offering one mid-search invites the
    // user to type an address they do not need.
    expect(lastFrame()).not.toMatch(/address/i);
  });

  it("explains mDNS when nothing was found, and offers the address field", () => {
    // The Docker / VLAN case. Without this the feature looks broken rather than
    // blocked, which is the whole reason the configured address exists.
    const { lastFrame } = setup({ devices: [], finding: false });
    expect(lastFrame()).toMatch(/No Chromecast found/i);
    expect(lastFrame()).toMatch(/Docker|VLAN/i);
  });

  it("submits a typed address", async () => {
    const { stdin, onAddress } = setup({ devices: [], finding: false });
    stdin.write("192.168.0.40");
    await flush();
    stdin.write("\r");
    await flush();
    expect(onAddress).toHaveBeenCalledWith("192.168.0.40");
  });

  it("shows the configured address as the field's placeholder, so it is discoverable", () => {
    const { lastFrame } = setup({ devices: [], finding: false, configured: "192.168.0.40" });
    expect(lastFrame()).toContain("192.168.0.40");
  });

  it("does not offer the field while devices exist, so nothing competes for the arrow keys", () => {
    const { lastFrame } = setup();
    expect(lastFrame()).not.toMatch(/type an address/i);
  });

  it("cancels on escape, in both states", async () => {
    const withDevices = setup();
    withDevices.stdin.write("");
    await flush();
    expect(withDevices.onCancel).toHaveBeenCalledOnce();
    const empty = setup({ devices: [], finding: false });
    empty.stdin.write("");
    await flush();
    expect(empty.onCancel).toHaveBeenCalledOnce();
  });

  it("selects nothing on enter when the list is empty, rather than crashing", async () => {
    const { stdin, onSelect, onAddress } = setup({ devices: [], finding: true });
    stdin.write("\r");
    await flush();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onAddress).not.toHaveBeenCalled();
  });
});
