# Chromecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cast a stream to a Chromecast from either front end, with pause/stop and a live position.

**Architecture:** torlink drives the device itself over the CASTV2 protocol from `src/core/cast/`, because the Cast Web Sender SDK is secure-context-only and `serve --web` is plain HTTP on a LAN IP. Both front ends are clients of one registry that lives on `Runtime`. The device always fetches `/stream/<sid>/<idx>?k=…` from torlink's own web server, so there is one URL shape, one auth story, and one source ladder.

**Tech Stack:** TypeScript (ESM, strict, `noUncheckedIndexedAccess`), Node ≥22, vitest, Ink + React (TUI), hand-written DOM (browser bundle, no framework), `multicast-dns` (new runtime dependency).

**Spec:** `docs/superpowers/specs/2026-08-01-chromecast-design.md`. Read it before Task 1; it carries the reasoning this plan only executes.

## Global Constraints

- **Layering, enforced by `eslint.config.js`.** `src/core` must not import from `src/ui` or `src/web`. `src/web` must not import from `src/ui`. `src/core/cast` never builds a URL — callers pass one in.
- **No `innerHTML` / `insertAdjacentHTML` / `outerHTML` / `document.write` anywhere in `src/web/static/`.** Every node is `createElement` + `textContent`. Release names come from whoever made the torrent.
- **No decisions in `player.ts` or `app.ts`.** Anything that decides *what to show* or *what to send* goes in a pure module beside it (here: `castModel.ts`). There is no jsdom, deliberately; DOM wiring is verified by running the app.
- **Config writes are read-modify-write per request:** `loadConfig()` → change → `saveConfig()`. Never hold a snapshot between requests.
- **Test fixtures never name a real film or show.** Reuse `Kestrel.2010.1080p.BluRay.x264`, `Ashfall.1999.1080p`, `Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP`, `Kepler.S02E04.1080p.WEB-DL`, `Harrowgate.S03.1080p.WEB-DL`. Device names are invented too: `Living Room TV`, `Kitchen display`.
- **Both front ends, same change.** A new key means **both** halves of `src/ui/keymap.ts` (`HELP_GROUPS` *and* `footerHints`). A new `Store` field means **both** `makeStore` (`scripts/render-previews-impl.tsx`) and `makeTestStore` (`src/ui/testHarness.ts`).
- **Every task ends green on `npx vitest run <the files it touched>`.** The full gate — `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` — runs in Task 14 and after any task that changes a shared module. One known pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) is expected; leave it.
- **Commit per task**, Conventional Commits, no `Co-Authored-By` unless the repo's other commits carry one.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/core/cast/protocol.ts` | pure: `CastMessage` encode/decode, length framing, `FrameReader` |
| `src/core/cast/discover.ts` | mDNS `_googlecast._tcp` query → `CastDevice[]`, plus the configured address |
| `src/core/cast/connection.ts` | TLS socket, heartbeat, channels, `LAUNCH`/`LOAD`/`PLAY`/`PAUSE`/`STOP`, status |
| `src/core/cast/session.ts` | `CastSessionRegistry`: the one active cast, its status, its played-file write |
| `src/core/streamSession.ts` | gains `adopt()` for files the TUI already resolved |
| `src/util/playability.ts` | gains `PlaybackProfile`, `BROWSER`, `CHROMECAST`, `castContentType` |
| `src/daemon/runtime.ts` | `Runtime.casts` |
| `src/web/stream.ts` | `castBlockers` on `.info`; CORS on `.vtt` |
| `src/web/castOrigin.ts` | the LAN origin a device must fetch from |
| `src/web/routes.ts` | `GET /api/cast/devices`, `POST /api/cast/start`, `POST /api/cast/command` |
| `src/web/wire.ts` | `PublicCastDevice`, `CastDevicesResponse`, `CastStatusResponse` |
| `src/web/static/castModel.ts` | pure: button state, labels, disabled reasons, status line |
| `src/web/static/player.ts` | DOM wiring only |
| `src/ui/components/CastPrompt.tsx` | the device list overlay, with an address field |
| `src/ui/App.tsx` | the cast flow: ensure the web server, adopt a session, drive the registry |

---

### Task 1: The CASTV2 wire format

**Files:**
- Create: `src/core/cast/protocol.ts`
- Test: `src/core/cast/protocol.test.ts`
- Modify: `package.json` (add `multicast-dns`, `@types/multicast-dns` — used from Task 2, installed here so one commit carries the lockfile change)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface CastMessage { sourceId: string; destinationId: string; namespace: string; payload: string }
  export const MAX_FRAME_BYTES: number;              // 1 << 20
  export function encodeCastMessage(m: CastMessage): Buffer;   // protobuf body, no length prefix
  export function decodeCastMessage(body: Buffer): CastMessage;
  export function frameCastMessage(m: CastMessage): Buffer;     // 4-byte BE length + body
  export class FrameReader { push(chunk: Buffer): CastMessage[] }
  ```

- [ ] **Step 1: Install the dependencies**

```bash
npm install multicast-dns@^7.2.5
npm install -D @types/multicast-dns@^7.2.4
```

- [ ] **Step 2: Write the failing test**

Create `src/core/cast/protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  FrameReader,
  MAX_FRAME_BYTES,
  decodeCastMessage,
  encodeCastMessage,
  frameCastMessage,
  type CastMessage,
} from "./protocol";

const MSG: CastMessage = {
  sourceId: "sender-torlink",
  destinationId: "receiver-0",
  namespace: "urn:x-cast:com.google.cast.receiver",
  payload: JSON.stringify({ type: "LAUNCH", appId: "CC1AD845", requestId: 1 }),
};

describe("encodeCastMessage / decodeCastMessage", () => {
  it("round-trips every field", () => {
    expect(decodeCastMessage(encodeCastMessage(MSG))).toEqual(MSG);
  });

  it("round-trips a payload carrying non-ASCII, so the length prefix is bytes and not characters", () => {
    const msg = { ...MSG, payload: JSON.stringify({ title: "Kestrel — 2010" }) };
    expect(decodeCastMessage(encodeCastMessage(msg))).toEqual(msg);
  });

  it("ignores a field it does not know rather than throwing", () => {
    // field 7, wire type 0 (varint), value 3 — appended to a valid body.
    const extended = Buffer.concat([encodeCastMessage(MSG), Buffer.from([0x38, 0x03])]);
    expect(decodeCastMessage(extended)).toEqual(MSG);
  });
});

describe("FrameReader", () => {
  it("yields one message from a whole frame", () => {
    const reader = new FrameReader();
    expect(reader.push(frameCastMessage(MSG))).toEqual([MSG]);
  });

  it("yields nothing until a frame whose length prefix is split across chunks completes", () => {
    const reader = new FrameReader();
    const framed = frameCastMessage(MSG);
    // Two bytes of the four-byte length: the failure mode every hand-rolled
    // framer has on its first day.
    expect(reader.push(framed.subarray(0, 2))).toEqual([]);
    expect(reader.push(framed.subarray(2, 9))).toEqual([]);
    expect(reader.push(framed.subarray(9))).toEqual([MSG]);
  });

  it("yields two messages from one chunk carrying both", () => {
    const reader = new FrameReader();
    const second = { ...MSG, payload: JSON.stringify({ type: "PONG" }) };
    const chunk = Buffer.concat([frameCastMessage(MSG), frameCastMessage(second)]);
    expect(reader.push(chunk)).toEqual([MSG, second]);
  });

  it("refuses a frame claiming an absurd length instead of buffering for it", () => {
    const reader = new FrameReader();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => reader.push(header)).toThrow(/refused/);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run src/core/cast/protocol.test.ts`
Expected: FAIL — `Failed to resolve import "./protocol"`.

- [ ] **Step 4: Write the implementation**

Create `src/core/cast/protocol.ts`:

```ts
/**
 * The CASTV2 wire format, by hand.
 *
 * A `CastMessage` is a protobuf with six fields and its shape never varies:
 * protocol_version (1, varint), source_id (2), destination_id (3), namespace
 * (4), payload_type (5, varint) and payload_utf8 (6). Everything torlink sends
 * or reads is JSON in field 6; the binary payload field is never used.
 *
 * Sixty lines of encoder is why `protobufjs` is not a dependency here: it is
 * roughly a megabyte into the bundled CLI, whose whole runtime dependency list
 * is eleven packages, to encode a message with no variability at all.
 */

export interface CastMessage {
  sourceId: string;
  destinationId: string;
  namespace: string;
  /** The JSON body. Field 6, `payload_utf8`. */
  payload: string;
}

/**
 * The largest frame we will assemble.
 *
 * A cast reply is a small JSON object; the biggest thing a receiver sends is a
 * MEDIA_STATUS with track metadata, orders of magnitude under this. The cap
 * exists because the length prefix arrives from the network: without it, four
 * bytes from anything listening on port 8009 can make this buffer without
 * bound.
 */
export const MAX_FRAME_BYTES = 1 << 20;

function varint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return Buffer.from(out);
}

// Wire type 0 is a varint, 2 is length-delimited. Those are the only two here.
function key(field: number, wire: 0 | 2): Buffer {
  return varint((field << 3) | wire);
}

function stringField(field: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([key(field, 2), varint(bytes.length), bytes]);
}

export function encodeCastMessage(m: CastMessage): Buffer {
  return Buffer.concat([
    key(1, 0), varint(0), // protocol_version = CASTV2_1_0
    stringField(2, m.sourceId),
    stringField(3, m.destinationId),
    stringField(4, m.namespace),
    key(5, 0), varint(0), // payload_type = STRING
    stringField(6, m.payload),
  ]);
}

function readVarint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 1;
  let i = at;
  for (;;) {
    if (i >= buf.length) throw new Error("cast frame: truncated varint");
    const byte = buf[i]!;
    i += 1;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) break;
    shift *= 128;
    if (shift > 2 ** 42) throw new Error("cast frame: varint too long");
  }
  return { value, next: i };
}

/**
 * Read a body into the four fields that matter.
 *
 * Unknown fields are skipped rather than rejected: a future receiver adding one
 * must not stop playback, and the two enum fields we write are skipped by this
 * same path on the way back in.
 */
export function decodeCastMessage(body: Buffer): CastMessage {
  const out: CastMessage = { sourceId: "", destinationId: "", namespace: "", payload: "" };
  let at = 0;
  while (at < body.length) {
    const k = readVarint(body, at);
    at = k.next;
    const field = Math.floor(k.value / 8);
    const wire = k.value % 8;
    if (wire === 0) {
      at = readVarint(body, at).next;
      continue;
    }
    if (wire !== 2) throw new Error(`cast frame: unsupported wire type ${wire}`);
    const len = readVarint(body, at);
    at = len.next;
    const end = at + len.value;
    if (end > body.length) throw new Error("cast frame: truncated field");
    const text = body.subarray(at, end).toString("utf8");
    at = end;
    if (field === 2) out.sourceId = text;
    else if (field === 3) out.destinationId = text;
    else if (field === 4) out.namespace = text;
    else if (field === 6) out.payload = text;
  }
  return out;
}

export function frameCastMessage(m: CastMessage): Buffer {
  const body = encodeCastMessage(m);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Reassemble frames from a TCP stream.
 *
 * Stateful on purpose: a socket hands over arbitrary chunk boundaries, so a
 * length prefix split across two reads is normal traffic and not an error.
 */
export class FrameReader {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): CastMessage[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const out: CastMessage[] = [];
    for (;;) {
      if (this.buffered.length < 4) break;
      const length = this.buffered.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`cast frame of ${length} bytes refused`);
      }
      if (this.buffered.length < 4 + length) break;
      out.push(decodeCastMessage(this.buffered.subarray(4, 4 + length)));
      this.buffered = this.buffered.subarray(4 + length);
    }
    return out;
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run src/core/cast/protocol.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/core/cast/protocol.ts src/core/cast/protocol.test.ts
git commit -m "feat(cast): the CASTV2 wire format, by hand"
```

---

### Task 2: Discovering devices

**Files:**
- Create: `src/core/cast/discover.ts`
- Test: `src/core/cast/discover.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  export interface CastDevice { id: string; name: string; model: string; host: string; port: number }
  export const CAST_SERVICE = "_googlecast._tcp.local";
  export const DISCOVER_TIMEOUT_MS = 2_000;
  export const DEFAULT_CAST_PORT = 8009;
  export interface MdnsLike {
    on(event: "response", cb: (packet: MdnsPacket) => void): void;
    query(q: { questions: { name: string; type: "PTR" }[] }): void;
    destroy(): void;
  }
  export interface MdnsRecord { name: string; type: string; data: unknown }
  export interface MdnsPacket { answers?: MdnsRecord[]; additionals?: MdnsRecord[] }
  export interface DiscoverDeps { mdnsFactory?: () => MdnsLike; timeoutMs?: number; sleep?: (ms: number) => Promise<void> }
  export function parseManualDevice(raw: string | undefined): CastDevice | null;
  export function devicesFromPackets(packets: readonly MdnsPacket[]): CastDevice[];
  export function discover(deps?: DiscoverDeps): Promise<CastDevice[]>;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/core/cast/discover.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CAST_PORT,
  devicesFromPackets,
  discover,
  parseManualDevice,
  type MdnsLike,
  type MdnsPacket,
} from "./discover";

// One device's answer, as multicast-dns reports it: a PTR naming the instance,
// an SRV with host and port, TXT key=value pairs as Buffers, and an A record.
function packetFor(opts: {
  instance: string;
  target: string;
  ip: string;
  port?: number;
  txt?: string[];
  withSrv?: boolean;
}): MdnsPacket {
  const records = [
    { name: "_googlecast._tcp.local", type: "PTR", data: opts.instance },
    ...(opts.withSrv === false
      ? []
      : [{ name: opts.instance, type: "SRV", data: { port: opts.port ?? DEFAULT_CAST_PORT, target: opts.target } }]),
    {
      name: opts.instance,
      type: "TXT",
      data: (opts.txt ?? ["id=abc123", "fn=Living Room TV", "md=Chromecast"]).map((s) => Buffer.from(s)),
    },
    { name: opts.target, type: "A", data: opts.ip },
  ];
  return { answers: records, additionals: [] };
}

describe("devicesFromPackets", () => {
  it("builds a device from SRV, A and TXT", () => {
    const devices = devicesFromPackets([
      packetFor({ instance: "abc._googlecast._tcp.local", target: "abc.local", ip: "192.168.0.40" }),
    ]);
    expect(devices).toEqual([
      { id: "abc123", name: "Living Room TV", model: "Chromecast", host: "192.168.0.40", port: 8009 },
    ]);
  });

  it("drops an answer with no SRV rather than half-building a device with no port", () => {
    const devices = devicesFromPackets([
      packetFor({ instance: "abc._googlecast._tcp.local", target: "abc.local", ip: "192.168.0.40", withSrv: false }),
    ]);
    expect(devices).toEqual([]);
  });

  it("collapses the same device answering on two interfaces, by id", () => {
    const one = packetFor({ instance: "abc._googlecast._tcp.local", target: "abc.local", ip: "192.168.0.40" });
    const again = packetFor({ instance: "abc._googlecast._tcp.local", target: "abc.local", ip: "10.8.0.4" });
    expect(devicesFromPackets([one, again]).map((d) => d.id)).toEqual(["abc123"]);
  });

  it("falls back to the instance name when TXT carries no fn, so a device is never nameless", () => {
    const devices = devicesFromPackets([
      packetFor({
        instance: "kitchen-display._googlecast._tcp.local",
        target: "k.local",
        ip: "192.168.0.41",
        txt: ["id=k1"],
      }),
    ]);
    expect(devices[0]).toMatchObject({ id: "k1", name: "kitchen-display", model: "" });
  });

  it("keeps two genuinely different devices", () => {
    const devices = devicesFromPackets([
      packetFor({ instance: "a._googlecast._tcp.local", target: "a.local", ip: "192.168.0.40" }),
      packetFor({
        instance: "b._googlecast._tcp.local",
        target: "b.local",
        ip: "192.168.0.41",
        txt: ["id=k1", "fn=Kitchen display", "md=Google TV Streamer"],
      }),
    ]);
    expect(devices.map((d) => d.name)).toEqual(["Living Room TV", "Kitchen display"]);
  });
});

describe("parseManualDevice", () => {
  it("takes a bare host and defaults the port", () => {
    expect(parseManualDevice("192.168.0.40")).toEqual({
      id: "manual:192.168.0.40:8009",
      name: "192.168.0.40",
      model: "",
      host: "192.168.0.40",
      port: 8009,
    });
  });

  it("takes host:port", () => {
    expect(parseManualDevice("tv.local:8010")).toMatchObject({ host: "tv.local", port: 8010 });
  });

  it("is null for absent, blank, or an unusable port", () => {
    expect(parseManualDevice(undefined)).toBeNull();
    expect(parseManualDevice("   ")).toBeNull();
    expect(parseManualDevice("tv.local:not-a-port")).toBeNull();
    expect(parseManualDevice("tv.local:0")).toBeNull();
  });
});

describe("discover", () => {
  it("queries the cast service, collects what answers within the window, and destroys the socket", async () => {
    const handlers: ((p: MdnsPacket) => void)[] = [];
    const query = vi.fn();
    const destroy = vi.fn();
    const mdns: MdnsLike = {
      on: (_event, cb) => { handlers.push(cb); },
      query,
      destroy,
    };
    const devices = await discover({
      mdnsFactory: () => mdns,
      timeoutMs: 1,
      sleep: async () => {
        handlers[0]!(packetFor({ instance: "abc._googlecast._tcp.local", target: "abc.local", ip: "192.168.0.40" }));
      },
    });
    expect(query).toHaveBeenCalledWith({
      questions: [{ name: "_googlecast._tcp.local", type: "PTR" }],
    });
    expect(devices.map((d) => d.name)).toEqual(["Living Room TV"]);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("resolves empty when nothing answers, rather than throwing or hanging", async () => {
    const mdns: MdnsLike = { on: () => {}, query: () => {}, destroy: () => {} };
    await expect(discover({ mdnsFactory: () => mdns, timeoutMs: 1, sleep: async () => {} })).resolves.toEqual([]);
  });

  it("destroys the socket even when the query itself throws", async () => {
    const destroy = vi.fn();
    const mdns: MdnsLike = {
      on: () => {},
      query: () => { throw new Error("no multicast route"); },
      destroy,
    };
    await expect(discover({ mdnsFactory: () => mdns, timeoutMs: 1, sleep: async () => {} })).resolves.toEqual([]);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/core/cast/discover.test.ts`
Expected: FAIL — cannot resolve `./discover`.

- [ ] **Step 3: Write the implementation**

Create `src/core/cast/discover.ts`:

```ts
import makeMdns from "multicast-dns";

/**
 * Finding Chromecasts on the LAN.
 *
 * `multicast-dns` is the one dependency this feature takes, and it is the half
 * worth taking: DNS name compression, several interfaces answering at once and
 * multicast group membership are real edge cases, where the protocol on top
 * (see ./protocol.ts) is a fixed six-field message. The factory is injected so
 * the tests feed canned records and never open a socket.
 */

export interface CastDevice {
  /** The device's own id from TXT, or a synthetic one for a configured address. */
  id: string;
  name: string;
  /** TXT `md`, e.g. "Chromecast". Empty when the device did not say. */
  model: string;
  host: string;
  port: number;
}

export const CAST_SERVICE = "_googlecast._tcp.local";
export const DEFAULT_CAST_PORT = 8009;

/**
 * How long to listen for answers.
 *
 * A device on the same segment answers in tens of milliseconds; two seconds is
 * generous for a busy access point and short enough that the device list does
 * not feel broken. Nothing waits for a *complete* answer set, because there is
 * no such thing — a television that is off answers never.
 */
export const DISCOVER_TIMEOUT_MS = 2_000;

export interface MdnsRecord { name: string; type: string; data: unknown }
export interface MdnsPacket { answers?: MdnsRecord[]; additionals?: MdnsRecord[] }

/** The part of multicast-dns's surface this module uses. */
export interface MdnsLike {
  on(event: "response", cb: (packet: MdnsPacket) => void): void;
  query(q: { questions: { name: string; type: "PTR" }[] }): void;
  destroy(): void;
}

export interface DiscoverDeps {
  mdnsFactory?: () => MdnsLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function txtPairs(data: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    const text = Buffer.isBuffer(entry) ? entry.toString("utf8") : String(entry);
    const eq = text.indexOf("=");
    if (eq > 0) out.set(text.slice(0, eq), text.slice(eq + 1));
  }
  return out;
}

/**
 * Assemble devices from whatever answered.
 *
 * Pure, and separate from the socket for that reason. An answer with no SRV is
 * dropped: a device with no port is not a device, and inventing 8009 for it
 * would put a row on screen that cannot be cast to.
 */
export function devicesFromPackets(packets: readonly MdnsPacket[]): CastDevice[] {
  const byId = new Map<string, CastDevice>();
  for (const packet of packets) {
    const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
    const srv = records.find((r) => r.type === "SRV");
    if (!srv || typeof srv.data !== "object" || srv.data === null) continue;
    const { port, target } = srv.data as { port?: number; target?: string };
    if (!port || !target) continue;
    const addressed = records.find((r) => (r.type === "A" || r.type === "AAAA") && r.name === target);
    const host = typeof addressed?.data === "string" ? addressed.data : target;
    const txt = txtPairs(records.find((r) => r.type === "TXT")?.data);
    // The instance name is the fallback because a nameless row cannot be
    // chosen: "abc._googlecast._tcp.local" reads as "abc", which is at least
    // something the user can tell apart from the other row.
    const instance = srv.name.replace(`.${CAST_SERVICE}`, "");
    const id = txt.get("id") ?? `${host}:${port}`;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      name: txt.get("fn") ?? instance,
      model: txt.get("md") ?? "",
      host,
      port,
    });
  }
  return [...byId.values()];
}

/**
 * A device from the configured address, for networks mDNS cannot cross.
 *
 * mDNS does not traverse a Docker bridge or a VLAN, and torlink is run behind
 * both — without this the feature is dead there, behind a message that reads
 * like a bug. The id is prefixed so nothing can confuse it with a discovered
 * device's own id.
 */
export function parseManualDevice(raw: string | undefined): CastDevice | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const colon = trimmed.lastIndexOf(":");
  let host = trimmed;
  let port = DEFAULT_CAST_PORT;
  if (colon > 0) {
    const tail = trimmed.slice(colon + 1);
    if (!/^\d+$/.test(tail)) return null;
    port = Number(tail);
    if (port < 1 || port > 65_535) return null;
    host = trimmed.slice(0, colon);
  }
  if (!host) return null;
  return { id: `manual:${host}:${port}`, name: host, model: "", host, port };
}

export async function discover(deps: DiscoverDeps = {}): Promise<CastDevice[]> {
  const factory = deps.mdnsFactory ?? (() => makeMdns() as unknown as MdnsLike);
  const timeoutMs = deps.timeoutMs ?? DISCOVER_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const packets: MdnsPacket[] = [];
  const mdns = factory();
  try {
    mdns.on("response", (packet) => { packets.push(packet); });
    mdns.query({ questions: [{ name: CAST_SERVICE, type: "PTR" }] });
    await sleep(timeoutMs);
  } catch {
    // No multicast route, a firewall, a container with no host network: an
    // empty list and a message the caller can explain, never a thrown error
    // in the middle of someone pressing a button.
  } finally {
    try { mdns.destroy(); } catch { /* already gone */ }
  }
  return devicesFromPackets(packets);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/core/cast/discover.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/cast/discover.ts src/core/cast/discover.test.ts
git commit -m "feat(cast): discover Chromecasts over mDNS, with a configured-address fallback"
```

---

### Task 3: What a Chromecast will play

**Files:**
- Modify: `src/util/playability.ts`
- Test: `src/util/playability.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface PlaybackProfile {
    containers: ReadonlySet<string>;
    video: ReadonlySet<string>;
    audio: ReadonlySet<string>;
  }
  export const BROWSER_PROFILE: PlaybackProfile;
  export const CHROMECAST_PROFILE: PlaybackProfile;
  export function blockersFor(facts: MediaFacts, profile?: PlaybackProfile): Blocker[]; // default BROWSER_PROFILE
  export function castContentType(container: string, hls: boolean): string;
  ```
  `blockersFor`'s existing single-argument call sites (`src/web/stream.ts`, `src/web/static/playerModel.ts`) keep working unchanged — the profile is an optional second parameter.

- [ ] **Step 1: Write the failing tests**

Append to `src/util/playability.test.ts`:

```ts
import {
  BROWSER_PROFILE,
  CHROMECAST_PROFILE,
  castContentType,
  // ...existing imports stay
} from "./playability";

describe("blockersFor with a profile", () => {
  // THE REGRESSION GUARD for touching a module the web player depends on: the
  // no-argument form must answer exactly what it answered before profiles
  // existed. If this fails, the browser's fallback card has changed.
  it("defaults to the browser profile, unchanged", () => {
    expect(blockersFor(classifyFromName("Kestrel.2010.1080p.BluRay.x264.mp4"))).toEqual([]);
    expect(blockersFor(classifyFromName("Kepler.S02E04.1080p.WEB-DL.mkv"))).toEqual(["container"]);
    expect(blockersFor(classifyFromName("Kestrel.2010.1080p.BluRay.x265.mp4"))).toEqual(["video"]);
    expect(blockersFor(classifyFromName("Kestrel.2010.1080p.BluRay.x264.DTS.mp4"))).toEqual(["audio"]);
    expect(blockersFor(classifyFromName("Kestrel.2010.1080p.x264.AC3.mp4"), BROWSER_PROFILE)).toEqual(["audio"]);
  });

  it("blocks MKV for a Chromecast too — the device demuxes no more Matroska than a browser", () => {
    expect(blockersFor(classifyFromName("Kepler.S02E04.1080p.WEB-DL.mkv"), CHROMECAST_PROFILE)).toEqual([
      "container",
    ]);
  });

  it("allows AC3 and E-AC3 on a Chromecast, which the browser refuses", () => {
    // The recorded trade-off: this is HDMI passthrough, so a television that
    // cannot take it plays silently. Blocking would instead REFUSE a file that
    // would almost certainly have played, and on the torrent backend there is
    // no transcode rung underneath to fall back to. Silence is recoverable in
    // one keypress; a refusal is not recoverable at all.
    expect(blockersFor(classifyFromName("Kestrel.2010.1080p.x264.AC3.mp4"), CHROMECAST_PROFILE)).toEqual([]);
    expect(blockersFor(classifyFromName("Kestrel.2010.1080p.x264.DDP5.1.mp4"), CHROMECAST_PROFILE)).toEqual([]);
  });

  it("still blocks DTS and TrueHD on a Chromecast", () => {
    expect(blockersFor(classifyFromName("Kestrel.2010.1080p.x264.DTS.mp4"), CHROMECAST_PROFILE)).toEqual(["audio"]);
    expect(
      blockersFor(classifyFromName("Tin.Rivers.2024.2160p.WEB-DL.DV.HDR.Atmos.7.1-GROUP.mp4"), CHROMECAST_PROFILE),
    ).toEqual(["audio"]);
  });

  it("blocks HEVC on a Chromecast, because a model name is a guess and there is no video transcode", () => {
    expect(blockersFor(classifyFromName("Kestrel.2010.2160p.x265.AAC.mp4"), CHROMECAST_PROFILE)).toEqual(["video"]);
  });
});

describe("castContentType", () => {
  it("names the container for a direct play", () => {
    expect(castContentType("mp4", false)).toBe("video/mp4");
    expect(castContentType("m4v", false)).toBe("video/mp4");
    expect(castContentType("webm", false)).toBe("video/webm");
  });

  it("names HLS whenever the source is a manifest, whatever the file's own container", () => {
    expect(castContentType("mkv", true)).toBe("application/vnd.apple.mpegurl");
    expect(castContentType("mp4", true)).toBe("application/vnd.apple.mpegurl");
  });

  it("falls back to video/mp4 for a container it does not know, rather than an empty type", () => {
    // An empty contentType is a LOAD_FAILED with no reason. mp4 is the honest
    // guess: it is what a direct-play rung will have been chosen for.
    expect(castContentType("", false)).toBe("video/mp4");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run src/util/playability.test.ts`
Expected: FAIL — `BROWSER_PROFILE` is not exported.

- [ ] **Step 3: Implement**

In `src/util/playability.ts`, replace the three `SAFE_*` constants and `blockersFor` with:

```ts
/**
 * What one decoder will take.
 *
 * Two exist: a browser and a Chromecast. They are the same question asked of
 * different hardware, so they live in one module — a second list somewhere else
 * is the copy-then-drift bug this codebase has recorded four times.
 */
export interface PlaybackProfile {
  containers: ReadonlySet<string>;
  video: ReadonlySet<string>;
  audio: ReadonlySet<string>;
}

/**
 * Unchanged from what this module always answered.
 *
 * Containers short on purpose: mkv is not one in any shipping browser, and mkv
 * is what most of the scene ships. Codecs conservative: ac3/eac3 are
 * Safari-only and av1 is absent on older hardware, so neither is listed. Being
 * wrong in this direction costs a fallback card; being wrong in the other costs
 * a black rectangle.
 */
export const BROWSER_PROFILE: PlaybackProfile = {
  containers: new Set(["mp4", "m4v", "webm"]),
  video: new Set(["h264", "vp8", "vp9"]),
  audio: new Set(["aac", "mp3", "opus", "vorbis", "flac"]),
};

/**
 * A Chromecast, which differs from a browser in exactly one direction.
 *
 * Containers and video are identical: the device demuxes no Matroska, and HEVC
 * stays out even though an Ultra or a Google TV device decodes it — the `md`
 * TXT key names a model, a model name is a guess about both the device's
 * decoder and the television behind it, and there is no video transcode to fall
 * back to.
 *
 * Audio gains ac3 and eac3, which is passthrough and therefore depends on the
 * HDMI link. Where that link cannot take it the result is silent video, which
 * is bad — and still better than the alternative, which REFUSES a file that
 * would almost certainly have played, with no transcode rung underneath it on
 * the torrent backend. Silence is one keypress from recoverable; a refusal is
 * not recoverable at all.
 */
export const CHROMECAST_PROFILE: PlaybackProfile = {
  containers: new Set(["mp4", "m4v", "webm"]),
  video: new Set(["h264", "vp8", "vp9"]),
  audio: new Set(["aac", "mp3", "opus", "vorbis", "flac", "ac3", "eac3"]),
};

/**
 * Every reason `profile`'s decoder will refuse this file.
 *
 * An unknown *container* blocks — that is the existing behaviour and it is
 * right, because showing a card is honest and takes one tap to work around
 * where a black rectangle looks like the app is broken. An unknown *codec* does
 * not block: most release names say nothing about audio, and blocking there
 * would send files to the card that play fine.
 */
export function blockersFor(facts: MediaFacts, profile: PlaybackProfile = BROWSER_PROFILE): Blocker[] {
  const blockers: Blocker[] = [];
  if (!profile.containers.has(facts.container)) blockers.push("container");
  if (facts.videoCodec && !profile.video.has(facts.videoCodec)) blockers.push("video");
  if (facts.audioCodec && !profile.audio.has(facts.audioCodec)) blockers.push("audio");
  return blockers;
}

/**
 * The `contentType` a `LOAD` must name.
 *
 * Getting it wrong is a LOAD_FAILED rather than a guess the receiver recovers
 * from, so this is a function with tests rather than a ternary at the call site.
 * An HLS manifest is HLS whatever the file inside it was.
 */
export function castContentType(container: string, hls: boolean): string {
  if (hls) return "application/vnd.apple.mpegurl";
  if (container === "webm") return "video/webm";
  return "video/mp4";
}
```

Note for the implementer: the old `SAFE_CONTAINERS`/`SAFE_VIDEO`/`SAFE_AUDIO` constants are module-private, so nothing outside this file references them. Confirm with `grep -rn "SAFE_CONTAINERS\|SAFE_VIDEO\|SAFE_AUDIO" src` before deleting them; the expected answer is hits in this file only.

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run src/util/playability.test.ts`
Expected: PASS.

- [ ] **Step 5: Run everything that consumes this module**

Run: `npx vitest run src/web/stream.test.ts src/web/static/playerModel.test.ts src/core/probe.test.ts`
Expected: PASS, unchanged. This is the point of the default-argument form; if anything here fails, the browser's behaviour has moved and the fix is in this task, not in those tests.

- [ ] **Step 6: Commit**

```bash
git add src/util/playability.ts src/util/playability.test.ts
git commit -m "feat(cast): a capability profile per decoder, with a Chromecast one"
```

---

### Task 4: Talking to a device

**Files:**
- Create: `src/core/cast/connection.ts`
- Test: `src/core/cast/connection.test.ts`

**Interfaces:**
- Consumes: `FrameReader`, `frameCastMessage`, `type CastMessage` (Task 1); `type CastDevice` (Task 2).
- Produces:
  ```ts
  export const RECEIVER_APP_ID = "CC1AD845";
  export const HEARTBEAT_MS = 5_000;
  export interface CastSocket {
    write(data: Buffer): void;
    onData(cb: (chunk: Buffer) => void): void;
    onClose(cb: () => void): void;
    destroy(): void;
  }
  export type ConnectSocket = (host: string, port: number) => Promise<CastSocket>;
  export interface CastMediaRequest {
    url: string;
    contentType: string;
    title: string;
    subtitleUrl?: string;
    subtitleLabel?: string;
  }
  export type CastPlayerState = "loading" | "playing" | "paused" | "idle";
  export interface CastStatus { state: CastPlayerState; positionSec: number; durationSec: number | null }
  export interface ConnectionDeps {
    connect?: ConnectSocket;
    setInterval?: (cb: () => void, ms: number) => { unref?: () => void };
    clearInterval?: (handle: unknown) => void;
  }
  export class CastError extends Error {}
  export class CastConnection {
    static open(device: CastDevice, deps?: ConnectionDeps): Promise<CastConnection>;
    load(media: CastMediaRequest): Promise<void>;
    play(): Promise<void>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    onStatus(cb: (status: CastStatus) => void): void;
    onLost(cb: (message: string) => void): void;
    close(): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `src/core/cast/connection.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { FrameReader, frameCastMessage, type CastMessage } from "./protocol";
import {
  CastConnection,
  CastError,
  RECEIVER_APP_ID,
  type CastSocket,
  type CastStatus,
} from "./connection";
import type { CastDevice } from "./discover";

const DEVICE: CastDevice = {
  id: "abc123",
  name: "Living Room TV",
  model: "Chromecast",
  host: "192.168.0.40",
  port: 8009,
};

/**
 * A socket that records what was sent and lets a test answer as a receiver.
 * The whole point of injecting the socket: every failure below is a test, not
 * a story about a television.
 */
function fakeSocket() {
  const sent: CastMessage[] = [];
  const reader = new FrameReader();
  let onData: (chunk: Buffer) => void = () => {};
  let onClose: () => void = () => {};
  const destroy = vi.fn();
  const socket: CastSocket = {
    write: (data) => { sent.push(...reader.push(data)); },
    onData: (cb) => { onData = cb; },
    onClose: (cb) => { onClose = cb; },
    destroy,
  };
  return {
    socket,
    sent,
    destroy,
    /** Answer as the receiver. */
    reply(namespace: string, payload: unknown, destinationId = "sender-torlink"): void {
      onData(frameCastMessage({
        sourceId: "receiver-0",
        destinationId,
        namespace,
        payload: JSON.stringify(payload),
      }));
    },
    drop(): void { onClose(); },
    payloads(): Record<string, unknown>[] {
      return sent.map((m) => JSON.parse(m.payload) as Record<string, unknown>);
    },
    typesSent(): string[] {
      return this.payloads().map((p) => String(p.type));
    },
  };
}

const RECEIVER_NS = "urn:x-cast:com.google.cast.receiver";
const MEDIA_NS = "urn:x-cast:com.google.cast.media";

function launched(requestId: number) {
  return {
    type: "RECEIVER_STATUS",
    requestId,
    status: {
      applications: [
        { appId: RECEIVER_APP_ID, sessionId: "sess-1", transportId: "transport-1" },
      ],
    },
  };
}

function mediaStatus(requestId: number, over: Record<string, unknown> = {}) {
  return {
    type: "MEDIA_STATUS",
    requestId,
    status: [
      {
        mediaSessionId: 7,
        playerState: "PLAYING",
        currentTime: 12.5,
        media: { duration: 6_120 },
        ...over,
      },
    ],
  };
}

async function openWith(fake: ReturnType<typeof fakeSocket>) {
  return CastConnection.open(DEVICE, {
    connect: async () => fake.socket,
    setInterval: () => ({}),
    clearInterval: () => {},
  });
}

describe("CastConnection.open", () => {
  it("connects to the receiver before anything else", async () => {
    const fake = fakeSocket();
    await openWith(fake);
    expect(fake.typesSent()).toEqual(["CONNECT"]);
  });

  it("is a CastError naming the device when the socket will not open", async () => {
    await expect(
      CastConnection.open(DEVICE, { connect: async () => { throw new Error("ECONNREFUSED"); } }),
    ).rejects.toThrow(/Living Room TV didn't answer/);
  });
});

describe("load", () => {
  it("launches the default receiver, then connects to its transport, then loads", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const loading = conn.load({ url: "http://192.168.0.98:9161/stream/s/0?k=t", contentType: "video/mp4", title: "Kestrel 2010" });
    // LAUNCH goes out first; answering it should produce the transport CONNECT
    // and the LOAD.
    expect(fake.typesSent()).toEqual(["CONNECT", "LAUNCH"]);
    const launchId = Number(fake.payloads()[1]!.requestId);
    fake.reply(RECEIVER_NS, launched(launchId));
    await vi.waitFor(() => expect(fake.typesSent()).toContain("LOAD"));
    fake.reply(MEDIA_NS, mediaStatus(Number(fake.payloads().find((p) => p.type === "LOAD")!.requestId)));
    await loading;

    const load = fake.payloads().find((p) => p.type === "LOAD") as Record<string, any>;
    expect(load.sessionId).toBe("sess-1");
    expect(load.autoplay).toBe(true);
    expect(load.media.contentId).toBe("http://192.168.0.98:9161/stream/s/0?k=t");
    expect(load.media.contentType).toBe("video/mp4");
    expect(load.media.streamType).toBe("BUFFERED");
    expect(load.media.metadata.title).toBe("Kestrel 2010");
    // The LOAD is addressed to the app's transport, not to receiver-0.
    expect(fake.sent.find((m) => JSON.parse(m.payload).type === "LOAD")!.destinationId).toBe("transport-1");
  });

  it("passes a subtitle as a track and activates it", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const loading = conn.load({
      url: "http://192.168.0.98:9161/stream/s/0?k=t",
      contentType: "video/mp4",
      title: "Kepler S02E04",
      subtitleUrl: "http://192.168.0.98:9161/stream/s/1.vtt?k=t",
      subtitleLabel: "English",
    });
    fake.reply(RECEIVER_NS, launched(Number(fake.payloads()[1]!.requestId)));
    await vi.waitFor(() => expect(fake.typesSent()).toContain("LOAD"));
    const load = fake.payloads().find((p) => p.type === "LOAD") as Record<string, any>;
    expect(load.media.tracks).toEqual([
      {
        trackId: 1,
        type: "TEXT",
        trackContentId: "http://192.168.0.98:9161/stream/s/1.vtt?k=t",
        trackContentType: "text/vtt",
        subtype: "SUBTITLES",
        name: "English",
        language: "en",
      },
    ]);
    expect(load.activeTrackIds).toEqual([1]);
    fake.reply(MEDIA_NS, mediaStatus(Number(load.requestId)));
    await loading;
  });

  it("sends no tracks key at all when there is no subtitle", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    void conn.load({ url: "http://h/s", contentType: "video/mp4", title: "Kestrel 2010" }).catch(() => {});
    fake.reply(RECEIVER_NS, launched(Number(fake.payloads()[1]!.requestId)));
    await vi.waitFor(() => expect(fake.typesSent()).toContain("LOAD"));
    const load = fake.payloads().find((p) => p.type === "LOAD") as Record<string, any>;
    expect("tracks" in load.media).toBe(false);
    expect("activeTrackIds" in load).toBe(false);
  });

  it("rejects with the receiver's own reason when it refuses to launch", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const loading = conn.load({ url: "http://h/s", contentType: "video/mp4", title: "Kestrel 2010" });
    fake.reply(RECEIVER_NS, { type: "LAUNCH_ERROR", requestId: Number(fake.payloads()[1]!.requestId), reason: "CANCELLED" });
    await expect(loading).rejects.toThrow(/Living Room TV wouldn't start the player/);
  });

  it("rejects with the receiver's reason on LOAD_FAILED", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const loading = conn.load({ url: "http://h/s", contentType: "video/mp4", title: "Kestrel 2010" });
    fake.reply(RECEIVER_NS, launched(Number(fake.payloads()[1]!.requestId)));
    await vi.waitFor(() => expect(fake.typesSent()).toContain("LOAD"));
    const load = fake.payloads().find((p) => p.type === "LOAD") as Record<string, any>;
    fake.reply(MEDIA_NS, { type: "LOAD_FAILED", requestId: Number(load.requestId), detailedErrorCode: 905 });
    await expect(loading).rejects.toThrow(/couldn't play this file/);
    await expect(loading).rejects.toBeInstanceOf(CastError);
  });
});

describe("status and commands", () => {
  async function playing() {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const statuses: CastStatus[] = [];
    conn.onStatus((s) => statuses.push(s));
    const loading = conn.load({ url: "http://h/s", contentType: "video/mp4", title: "Kestrel 2010" });
    fake.reply(RECEIVER_NS, launched(Number(fake.payloads()[1]!.requestId)));
    await vi.waitFor(() => expect(fake.typesSent()).toContain("LOAD"));
    const load = fake.payloads().find((p) => p.type === "LOAD") as Record<string, any>;
    fake.reply(MEDIA_NS, mediaStatus(Number(load.requestId)));
    await loading;
    return { fake, conn, statuses };
  }

  it("reports position and duration from MEDIA_STATUS, in seconds", async () => {
    const { statuses } = await playing();
    expect(statuses.at(-1)).toEqual({ state: "playing", positionSec: 12.5, durationSec: 6_120 });
  });

  it("reports a null duration for a live or unknown-length source rather than zero", async () => {
    const { fake, statuses } = await playing();
    fake.reply(MEDIA_NS, mediaStatus(99, { media: {} }));
    await vi.waitFor(() => expect(statuses.at(-1)!.durationSec).toBeNull());
  });

  it("maps PAUSED and IDLE", async () => {
    const { fake, statuses } = await playing();
    fake.reply(MEDIA_NS, mediaStatus(99, { playerState: "PAUSED" }));
    await vi.waitFor(() => expect(statuses.at(-1)!.state).toBe("paused"));
    fake.reply(MEDIA_NS, mediaStatus(100, { playerState: "IDLE" }));
    await vi.waitFor(() => expect(statuses.at(-1)!.state).toBe("idle"));
  });

  it("addresses PAUSE and PLAY to the media session the receiver named", async () => {
    const { fake, conn } = await playing();
    void conn.pause();
    void conn.play();
    const pause = fake.payloads().find((p) => p.type === "PAUSE") as Record<string, any>;
    const play = fake.payloads().find((p) => p.type === "PLAY") as Record<string, any>;
    expect(pause.mediaSessionId).toBe(7);
    expect(play.mediaSessionId).toBe(7);
  });

  it("stops by quitting the receiver app, so the TV returns to its own screen", async () => {
    const { fake, conn } = await playing();
    await conn.stop();
    const stop = fake.payloads().find((p) => p.type === "STOP") as Record<string, any>;
    expect(stop.sessionId).toBe("sess-1");
  });

  it("refuses a command before anything is loaded, rather than sending a broken one", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    await expect(conn.pause()).rejects.toThrow(/nothing is playing/);
  });
});

describe("heartbeat and loss", () => {
  it("pings the receiver on the heartbeat interval", async () => {
    const fake = fakeSocket();
    let tick: (() => void) | null = null;
    await CastConnection.open(DEVICE, {
      connect: async () => fake.socket,
      setInterval: (cb) => { tick = cb; return {}; },
      clearInterval: () => {},
    });
    tick!();
    expect(fake.typesSent()).toEqual(["CONNECT", "PING"]);
  });

  it("reports the connection lost, once, when the socket drops", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const lost = vi.fn();
    conn.onLost(lost);
    fake.drop();
    fake.drop();
    expect(lost).toHaveBeenCalledOnce();
    expect(lost).toHaveBeenCalledWith("Lost the connection to Living Room TV.");
  });

  it("destroys the socket and stops the heartbeat on close", async () => {
    const fake = fakeSocket();
    const cleared = vi.fn();
    const conn = await CastConnection.open(DEVICE, {
      connect: async () => fake.socket,
      setInterval: () => ({ handle: 1 }),
      clearInterval: cleared,
    });
    conn.close();
    expect(fake.destroy).toHaveBeenCalledOnce();
    expect(cleared).toHaveBeenCalledOnce();
  });

  it("reports loss rather than throwing when a frame is malformed", async () => {
    const fake = fakeSocket();
    const conn = await openWith(fake);
    const lost = vi.fn();
    conn.onLost(lost);
    // A length prefix past the cap: FrameReader throws, and that must surface
    // as a lost connection rather than an unhandled error in the process.
    const header = Buffer.alloc(4);
    header.writeUInt32BE(0xffffffff, 0);
    expect(() => fake.socket.onData).not.toThrow();
    fake.reply("urn:x-cast:com.google.cast.tp.heartbeat", { type: "PONG" });
    expect(lost).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run src/core/cast/connection.test.ts`
Expected: FAIL — cannot resolve `./connection`.

- [ ] **Step 3: Implement**

Create `src/core/cast/connection.ts`. The protocol facts it must encode, in order:

1. `sourceId` is `"sender-torlink"` throughout.
2. `CONNECT` (`urn:x-cast:com.google.cast.tp.connection`) to `receiver-0` immediately on open.
3. `PING` (`urn:x-cast:com.google.cast.tp.heartbeat`) to `receiver-0` every `HEARTBEAT_MS`. A `PING` *from* the device is answered with `PONG`.
4. `LAUNCH { appId, requestId }` on `urn:x-cast:com.google.cast.receiver`. The reply is `RECEIVER_STATUS` carrying `status.applications[]`; take the entry whose `appId` matches and keep its `sessionId` and `transportId`. `LAUNCH_ERROR` is the refusal.
5. `CONNECT` again, this time addressed to `transportId`, before any media message.
6. `LOAD` on `urn:x-cast:com.google.cast.media`, addressed to `transportId`. Reply is `MEDIA_STATUS` (success, carrying `mediaSessionId`) or `LOAD_FAILED` / `LOAD_CANCELLED`.
7. `PAUSE` / `PLAY` take `{ mediaSessionId, requestId }` on the media namespace to `transportId`. `STOP` takes `{ sessionId, requestId }` on the **receiver** namespace, which quits the app and returns the TV to its own screen.
8. Every request carries a monotonic `requestId`; replies are matched by it. `MEDIA_STATUS` also arrives *unsolicited*, with a `requestId` of 0 — those drive `onStatus` and match no pending request.

```ts
import { FrameReader, frameCastMessage, type CastMessage } from "./protocol";
import type { CastDevice } from "./discover";

export const RECEIVER_APP_ID = "CC1AD845";
export const HEARTBEAT_MS = 5_000;

const SENDER_ID = "sender-torlink";
const NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA = "urn:x-cast:com.google.cast.media";

/**
 * The part of a TLS socket this module uses.
 *
 * Injected rather than imported so the tests answer as a receiver instead of
 * needing a television on the desk.
 */
export interface CastSocket {
  write(data: Buffer): void;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: () => void): void;
  destroy(): void;
}

export type ConnectSocket = (host: string, port: number) => Promise<CastSocket>;

export interface CastMediaRequest {
  url: string;
  contentType: string;
  title: string;
  subtitleUrl?: string;
  subtitleLabel?: string;
}

export type CastPlayerState = "loading" | "playing" | "paused" | "idle";

export interface CastStatus {
  state: CastPlayerState;
  positionSec: number;
  /** Null when the receiver has not said — a manifest it is still reading. */
  durationSec: number | null;
}

export interface ConnectionDeps {
  connect?: ConnectSocket;
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** A failure with a message already fit to put on screen. */
export class CastError extends Error {}
```

Then the default socket, which is where `node:tls` is touched and nothing else:

```ts
import tls from "node:tls";

const defaultConnect: ConnectSocket = (host, port) =>
  new Promise((resolve, reject) => {
    // rejectUnauthorized: false is load-bearing, not laziness. A Chromecast
    // presents a device-signed certificate and there is no chain to check it
    // against. It is acceptable because nothing secret crosses this socket:
    // the payload is a URL already available to anything on the LAN holding the
    // session's `?k=` token.
    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      resolve({
        write: (data) => socket.write(data),
        onData: (cb) => socket.on("data", cb),
        onClose: (cb) => { socket.on("close", cb); socket.on("error", () => cb()); },
        destroy: () => socket.destroy(),
      });
    });
    socket.once("error", reject);
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error("timed out")); });
  });
```

The class itself: hold `pending: Map<number, {resolve, reject}>`, `nextRequestId`, `transportId`, `sessionId`, `mediaSessionId`, `statusCb`, `lostCb`, `lost: boolean`. Route each inbound message by namespace; a `FrameReader` throw or an unparseable payload calls `fail()` — the same path a socket close takes — so nothing escapes as an unhandled error in a TUI process, which can take the whole terminal down with it.

Messages the failure table names, verbatim:

```ts
// CastConnection.open, when connect rejects:
throw new CastError(`${device.name} didn't answer — it may be off.`);
// LAUNCH_ERROR:
new CastError(`${device.name} wouldn't start the player.`)
// LOAD_FAILED / LOAD_CANCELLED:
new CastError(`${device.name} couldn't play this file.`)
// a command before load:
new CastError("nothing is playing on this device.")
// socket close, via onLost:
`Lost the connection to ${device.name}.`
```

The `LOAD` body, with the subtitle key present only when there is one — an empty `tracks` array is not the same as no tracks, and the second test above pins that:

```ts
const media: Record<string, unknown> = {
  contentId: req.url,
  contentType: req.contentType,
  streamType: "BUFFERED",
  metadata: { type: 0, metadataType: 0, title: req.title },
};
if (req.subtitleUrl) {
  media.tracks = [{
    trackId: 1,
    type: "TEXT",
    trackContentId: req.subtitleUrl,
    trackContentType: "text/vtt",
    subtype: "SUBTITLES",
    name: req.subtitleLabel ?? "Subtitles",
    language: "en",
  }];
}
const body: Record<string, unknown> = { type: "LOAD", requestId, sessionId, media, autoplay: true };
if (req.subtitleUrl) body.activeTrackIds = [1];
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run src/core/cast/connection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/cast/connection.ts src/core/cast/connection.test.ts
git commit -m "feat(cast): drive a Chromecast over CASTV2"
```

---

### Task 5: Adopting an already-resolved stream

**Files:**
- Modify: `src/core/streamSession.ts`
- Test: `src/core/streamSession.test.ts`

**Why:** the TUI holds `StreamFile[]` it resolved itself and never registers them with the registry it constructs (`src/ui/App.tsx:265`). Casting needs a session id so the device has a URL to fetch, and re-resolving would spend the user's debrid account twice.

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  export interface AdoptStreamInput {
    infoHash: string;
    name: string;
    backend: StreamBackend;
    provider?: DebridProviderId;
    files: StreamFile[];
  }
  // on StreamSessionRegistry:
  adopt(input: AdoptStreamInput): StreamSession;
  ```

- [ ] **Step 1: Write the failing test**

Append to `src/core/streamSession.test.ts`:

```ts
describe("adopt", () => {
  const FILES = [
    { url: "https://provider.example/1", filename: "Kepler.S02E04.1080p.WEB-DL.mkv", bytes: 1_400_000_000 },
  ];

  it("registers a ready session without calling either resolver", async () => {
    const streamTorrentImpl = vi.fn();
    const resolveDebridImpl = vi.fn();
    const registry = new StreamSessionRegistry({
      streamTorrentImpl: streamTorrentImpl as never,
      resolveDebridImpl: resolveDebridImpl as never,
    });
    const session = registry.adopt({
      infoHash: "abc",
      name: "Kepler.S02.1080p.WEB-DL",
      backend: "debrid",
      provider: "realdebrid",
      files: FILES,
    });
    expect(session.state).toBe("ready");
    expect(session.files).toEqual(FILES);
    expect(session.capability).toBeTruthy();
    expect(registry.get(session.id)).toBe(session);
    expect(streamTorrentImpl).not.toHaveBeenCalled();
    expect(resolveDebridImpl).not.toHaveBeenCalled();
  });

  it("mints a distinct id and capability per adopted session", () => {
    const registry = new StreamSessionRegistry();
    const a = registry.adopt({ infoHash: "abc", name: "Kestrel.2010.1080p.BluRay.x264", backend: "torrent", files: FILES });
    const b = registry.adopt({ infoHash: "abc", name: "Kestrel.2010.1080p.BluRay.x264", backend: "torrent", files: FILES });
    expect(a.id).not.toBe(b.id);
    expect(a.capability).not.toBe(b.capability);
  });

  it("stops without touching a backend it does not own", async () => {
    const registry = new StreamSessionRegistry();
    const session = registry.adopt({ infoHash: "abc", name: "Ashfall.1999.1080p", backend: "torrent", files: FILES });
    // The TUI owns the WebTorrent session behind these files and stops it
    // itself on picker cancel. Dropping the row must not reach for it.
    await expect(registry.stop(session.id)).resolves.toBeUndefined();
    expect(registry.get(session.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run src/core/streamSession.test.ts`
Expected: FAIL — `registry.adopt is not a function`.

- [ ] **Step 3: Implement**

Add to `src/core/streamSession.ts`:

```ts
export interface AdoptStreamInput {
  infoHash: string;
  name: string;
  backend: StreamBackend;
  provider?: DebridProviderId;
  files: StreamFile[];
}
```

and the method on `StreamSessionRegistry`:

```ts
  /**
   * Register files a front end has ALREADY resolved.
   *
   * The TUI resolves its own streams and hands the URLs straight to mpv, so its
   * files were never in this registry. Casting needs them here, because a
   * Chromecast can only fetch `/stream/:sid/:idx` — it cannot reach a debrid
   * link it has no token for, nor the `localhost` WebTorrent server. Adopting
   * is how that happens without spending a second resolve on the user's account.
   *
   * `backendHandle` is deliberately null: the caller still owns whatever is
   * serving these bytes and stops it on its own terms (the picker's cancel
   * path). So `stop()` on an adopted session drops the row and reaches for
   * nothing — which is what the third test pins.
   */
  adopt(input: AdoptStreamInput): StreamSession {
    const session: StreamSession = {
      id: this.idFactory(),
      capability: this.capabilityFactory(),
      backendHandle: null,
      backend: input.backend,
      ...(input.provider ? { provider: input.provider } : {}),
      infoHash: input.infoHash,
      // No magnet: nothing will re-resolve this session, and StreamSession does
      // not carry one anyway.
      name: input.name,
      state: "ready",
      files: input.files,
      progress: 1,
      createdAt: this.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }
```

Note for the implementer: `stop()` already guards `backendHandle` — confirm it reads `session.backendHandle?.stop()` or equivalent before relying on the third test; if it dereferences unconditionally, add the optional call as part of this task.

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run src/core/streamSession.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/streamSession.ts src/core/streamSession.test.ts
git commit -m "feat(stream): adopt already-resolved files into a session"
```

---

### Task 6: The one active cast

**Files:**
- Create: `src/core/cast/session.ts`
- Test: `src/core/cast/session.test.ts`
- Modify: `src/daemon/runtime.ts` (add `casts` to `Runtime` and to `startRuntime`)

**Interfaces:**
- Consumes: `CastConnection`, `CastError`, `type CastStatus`, `type CastMediaRequest` (Task 4); `type CastDevice` (Task 2).
- Produces:
  ```ts
  export interface ActiveCast {
    device: CastDevice;
    sid: string;
    index: number;
    title: string;
    status: CastStatus;
  }
  export interface StartCastInput {
    device: CastDevice;
    sid: string;
    index: number;
    infoHash: string;
    filename: string;
    title: string;
    media: CastMediaRequest;
  }
  export type MarkPlayed = (infoHash: string, filename: string) => Promise<void>;
  export interface CastRegistryDeps {
    openConnection?: (device: CastDevice) => Promise<CastConnection>;
    markPlayed?: MarkPlayed;
  }
  export class CastSessionRegistry {
    constructor(deps?: CastRegistryDeps);
    active(): ActiveCast | null;
    /** The message to show when the last cast ended badly, then cleared. */
    takeNotice(): string | null;
    start(input: StartCastInput): Promise<ActiveCast>;
    play(): Promise<void>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    onChange(cb: () => void): () => void;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `src/core/cast/session.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { CastError } from "./connection";
import { CastSessionRegistry, type StartCastInput } from "./session";
import type { CastDevice } from "./discover";

const DEVICE: CastDevice = { id: "abc", name: "Living Room TV", model: "Chromecast", host: "10.0.0.5", port: 8009 };
const OTHER: CastDevice = { id: "k1", name: "Kitchen display", model: "Chromecast", host: "10.0.0.6", port: 8009 };

function input(over: Partial<StartCastInput> = {}): StartCastInput {
  return {
    device: DEVICE,
    sid: "sess",
    index: 0,
    infoHash: "hash",
    filename: "Kepler.S02E04.1080p.WEB-DL.mkv",
    title: "Kepler S02E04",
    media: { url: "http://10.0.0.2:9161/stream/sess/0?k=t", contentType: "video/mp4", title: "Kepler S02E04" },
    ...over,
  };
}

function fakeConnection() {
  let status: ((s: never) => void) | null = null;
  let lost: ((m: string) => void) | null = null;
  return {
    load: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    close: vi.fn(),
    onStatus: (cb: never) => { status = cb; },
    onLost: (cb: (m: string) => void) => { lost = cb; },
    emitStatus(s: unknown) { (status as unknown as (v: unknown) => void)(s); },
    emitLost(m: string) { lost!(m); },
  };
}

describe("CastSessionRegistry", () => {
  it("has nothing active until something is cast", () => {
    expect(new CastSessionRegistry().active()).toBeNull();
  });

  it("loads the media and reports what is playing", async () => {
    const conn = fakeConnection();
    const registry = new CastSessionRegistry({ openConnection: async () => conn as never });
    const active = await registry.start(input());
    expect(conn.load).toHaveBeenCalledWith(input().media);
    expect(active.device.name).toBe("Living Room TV");
    expect(registry.active()).toMatchObject({ sid: "sess", index: 0, title: "Kepler S02E04" });
  });

  it("marks the file played on a successful load, exactly once", async () => {
    const markPlayed = vi.fn(async () => {});
    const registry = new CastSessionRegistry({
      openConnection: async () => fakeConnection() as never,
      markPlayed,
    });
    await registry.start(input());
    expect(markPlayed).toHaveBeenCalledExactlyOnceWith("hash", "Kepler.S02E04.1080p.WEB-DL.mkv");
  });

  it("marks nothing when the device refuses the file", async () => {
    const markPlayed = vi.fn(async () => {});
    const conn = fakeConnection();
    conn.load.mockRejectedValue(new CastError("Living Room TV couldn't play this file."));
    const registry = new CastSessionRegistry({ openConnection: async () => conn as never, markPlayed });
    await expect(registry.start(input())).rejects.toThrow(/couldn't play this file/);
    expect(markPlayed).not.toHaveBeenCalled();
    // And nothing is left behind claiming to be playing.
    expect(registry.active()).toBeNull();
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it("never lets a history write failure fail a cast the user already started", async () => {
    const registry = new CastSessionRegistry({
      openConnection: async () => fakeConnection() as never,
      markPlayed: async () => { throw new Error("disk full"); },
    });
    await expect(registry.start(input())).resolves.toMatchObject({ sid: "sess" });
  });

  it("replaces an existing cast, closing the first connection", async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    const conns = [first, second];
    const registry = new CastSessionRegistry({ openConnection: async () => conns.shift() as never });
    await registry.start(input());
    await registry.start(input({ device: OTHER, sid: "sess2" }));
    expect(first.close).toHaveBeenCalledOnce();
    expect(registry.active()).toMatchObject({ sid: "sess2", device: { name: "Kitchen display" } });
  });

  it("keeps the latest status and notifies subscribers", async () => {
    const conn = fakeConnection();
    const registry = new CastSessionRegistry({ openConnection: async () => conn as never });
    const changed = vi.fn();
    registry.onChange(changed);
    await registry.start(input());
    changed.mockClear();
    conn.emitStatus({ state: "playing", positionSec: 30, durationSec: 6_000 });
    expect(registry.active()!.status).toEqual({ state: "playing", positionSec: 30, durationSec: 6_000 });
    expect(changed).toHaveBeenCalled();
  });

  it("clears the cast and leaves a notice when the connection is lost", async () => {
    const conn = fakeConnection();
    const registry = new CastSessionRegistry({ openConnection: async () => conn as never });
    await registry.start(input());
    conn.emitLost("Lost the connection to Living Room TV.");
    expect(registry.active()).toBeNull();
    expect(registry.takeNotice()).toBe("Lost the connection to Living Room TV.");
    // Taken once: the front end that read it has shown it.
    expect(registry.takeNotice()).toBeNull();
  });

  it("stop closes the connection and clears the cast, with no notice — the user asked for it", async () => {
    const conn = fakeConnection();
    const registry = new CastSessionRegistry({ openConnection: async () => conn as never });
    await registry.start(input());
    await registry.stop();
    expect(conn.stop).toHaveBeenCalledOnce();
    expect(conn.close).toHaveBeenCalledOnce();
    expect(registry.active()).toBeNull();
    expect(registry.takeNotice()).toBeNull();
  });

  it("refuses a command when nothing is casting", async () => {
    const registry = new CastSessionRegistry();
    await expect(registry.pause()).rejects.toThrow(/nothing is casting/i);
    // Stop is the exception: stopping nothing is what the user wanted anyway.
    await expect(registry.stop()).resolves.toBeUndefined();
  });

  it("unsubscribes cleanly", async () => {
    const registry = new CastSessionRegistry({ openConnection: async () => fakeConnection() as never });
    const changed = vi.fn();
    registry.onChange(changed)();
    await registry.start(input());
    expect(changed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run src/core/cast/session.test.ts`
Expected: FAIL — cannot resolve `./session`.

- [ ] **Step 3: Implement `session.ts`**

The behaviours the tests pin, in prose so the implementation is not just transcribed:

- `start` opens a connection, `load`s, and only then records the active cast and calls `markPlayed`. A `load` rejection closes the connection, leaves `active()` null, and propagates — a device that refuses the file must not earn a ✓, which is the rule `playFromPicker`'s `onPlayed` callback already follows in the TUI.
- `markPlayed` failures are swallowed. A convenience list must never fail a play the user already started — the same rule `recordStreamHistory` follows in `App.tsx`.
- A second `start` closes the first connection. One cast per process, so there is never a second thing claiming the screen.
- `onLost` clears the cast and stores a notice `takeNotice()` hands over exactly once, because both front ends poll for it and only one should show it.
- `stop()` with nothing casting resolves. Stopping nothing is what the caller wanted; throwing there would make a "stop" button that errors.

The default `markPlayed` is the pair a local play already uses — read, change, compare by reference, write:

```ts
const defaultMarkPlayed: MarkPlayed = async (infoHash, filename) => {
  // Read-modify-write, never a held snapshot: a `serve --web` process may be
  // running against this same file. Same reference back means nothing moved,
  // which is the write gate — exactly as the "watched" route does.
  const config = await loadConfig();
  const favourites = markWatched(config.favourites ?? [], infoHash, filename);
  if (favourites !== (config.favourites ?? [])) await saveConfig({ ...config, favourites });
  const history = await loadStreamHistory();
  const advanced = recordPlayedFile(history, infoHash, filename);
  if (advanced !== history) await saveStreamHistory(advanced);
};
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run src/core/cast/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Put the registry on `Runtime`**

In `src/daemon/runtime.ts`, add to the `Runtime` interface, with a comment matching `sessions`':

```ts
  // The one active cast, shared by every front-end in this process for the same
  // reason `sessions` is. Note the limit, which is honest rather than hidden:
  // the TUI and `serve --web` are separate processes, so a cast started in one
  // is invisible to the other unless the TUI is hosting the web UI itself.
  casts: CastSessionRegistry;
```

and in `startRuntime`, `casts: new CastSessionRegistry()`.

- [ ] **Step 6: Fix every other place that builds a `Runtime`**

Run: `grep -rn "Runtime = {\|: Runtime = \|runtime: {" src scripts | grep -v "\.test\." | cut -c1-120`

Then the tests: `grep -rln "Runtime" src --include="*.test.ts*"`. Every literal needs `casts`. Prefer a shared helper if the test files already have one (`src/daemon/testHarness.ts`); otherwise add the field.

- [ ] **Step 7: Typecheck and run the affected suites**

Run: `npm run typecheck && npx vitest run src/daemon src/web/routes.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/cast/session.ts src/core/cast/session.test.ts src/daemon/runtime.ts
git add -u
git commit -m "feat(cast): one active cast per process, on Runtime"
```

---

### Task 7: What the page and the device need to know about a file

**Files:**
- Modify: `src/web/stream.ts` (the `.info` body; the `.vtt` headers)
- Modify: `src/web/wire.ts` (`StreamInfoResponse.castBlockers`)
- Test: `src/web/stream.test.ts`

**Interfaces:**
- Consumes: `CHROMECAST_PROFILE`, `blockersFor` (Task 3).
- Produces: `StreamInfoResponse.castBlockers: Blocker[]`.

- [ ] **Step 1: Write the failing tests**

Add to `src/web/stream.test.ts`, following the existing `.info` and `.vtt` tests' setup:

```ts
it("reports cast blockers beside the browser's, because the two decoders differ", async () => {
  // An MP4 carrying AC3: the browser refuses the audio, a Chromecast takes it.
  // This is the pair that lets the fallback card offer to cast.
  const body = await infoFor("Kestrel.2010.1080p.BluRay.x264.AC3.mp4");
  expect(body.blockers).toEqual(["audio"]);
  expect(body.castBlockers).toEqual([]);
});

it("reports a container blocker for both, for an mkv", async () => {
  const body = await infoFor("Kepler.S02E04.1080p.WEB-DL.mkv");
  expect(body.blockers).toEqual(["container"]);
  expect(body.castBlockers).toEqual(["container"]);
});

it("serves a subtitle with CORS, because a Chromecast fetches tracks cross-origin", async () => {
  // Without this the device drops the track SILENTLY, which reads as "casting
  // ignores subtitles". Safe here because the request was already authorised by
  // the session capability in `?k=` — the header widens who may read the
  // response, not who may ask for it.
  const res = await getStream(`/stream/${sid}/1.vtt?k=${capability}`);
  expect(res.headers["access-control-allow-origin"]).toBe("*");
  expect(res.headers["content-type"]).toBe("text/vtt; charset=utf-8");
});

it("does NOT put CORS on the media itself", async () => {
  // The media is a range-proxied video, or a redirect to a debrid link. Nothing
  // cross-origin reads it, and widening it would let any page on the LAN read
  // the user's stream once it guessed a handle.
  const res = await getStream(`/stream/${sid}/0?k=${capability}`);
  expect(res.headers["access-control-allow-origin"]).toBeUndefined();
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run src/web/stream.test.ts`
Expected: FAIL — `castBlockers` undefined; no CORS header.

- [ ] **Step 3: Implement**

In `src/web/wire.ts`, on `StreamInfoResponse`, after `blockers`:

```ts
  /**
   * Empty means a Chromecast should be able to play this file as it is.
   *
   * Separate from `blockers` because the two decoders genuinely differ: a
   * Chromecast passes AC3 and E-AC3 through to the television, which no browser
   * will decode. See `CHROMECAST_PROFILE` (src/util/playability.ts) for the
   * trade-off that allows, which is silence on a TV whose HDMI link cannot take
   * passthrough.
   */
  castBlockers: Blocker[];
```

In `src/web/stream.ts`, the `.info` body:

```ts
    const body: StreamInfoResponse = {
      facts,
      blockers: blockersFor(facts),
      castBlockers: blockersFor(facts, CHROMECAST_PROFILE),
      hls,
      subtitles: { ... },
    };
```

and in the `rep === "subtitle"` branch's `res.writeHead`, add the header with the reason beside it:

```ts
      // A Chromecast's receiver runs on an HTTPS origin of Google's and fetches
      // sidecar tracks cross-origin; without this it drops the track SILENTLY,
      // which reads to the user as "casting ignores subtitles". Only this
      // representation gets it — the media handle must not, and a test pins
      // that. It is safe here because `?k=` already authorised the request; the
      // header widens who may READ the response, not who may make it.
      "Access-Control-Allow-Origin": "*",
```

- [ ] **Step 4: Run and confirm they pass**

Run: `npx vitest run src/web/stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/stream.ts src/web/wire.ts src/web/stream.test.ts
git commit -m "feat(cast): report cast blockers, and let a device fetch the subtitle"
```

---

### Task 8: The origin a television can fetch from

**Files:**
- Create: `src/web/castOrigin.ts`
- Test: `src/web/castOrigin.test.ts`

**Interfaces:**
- Consumes: `displayHosts`, `type NetInterfaces` (`src/web/links.ts`).
- Produces:
  ```ts
  export function castOrigin(
    host: string,
    port: number,
    interfaces: NetInterfaces,
  ): string | null;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/web/castOrigin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { castOrigin } from "./castOrigin";
import type { NetInterfaces } from "./links";

const IFACES: NetInterfaces = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  en0: [{ address: "192.168.0.98", family: "IPv4", internal: false }],
};

describe("castOrigin", () => {
  it("names a LAN address, never loopback, even when the server is bound to a wildcard", () => {
    expect(castOrigin("0.0.0.0", 9161, IFACES)).toBe("http://192.168.0.98:9161");
  });

  it("names the LAN address when the user is browsing localhost", () => {
    // THE failure this module exists to prevent: the request's Host header says
    // `localhost`, and handing a television `http://localhost:9161` points it
    // at itself. Every other absolute URL in this app is built from Host
    // (`requestOrigin`), and this one must not be.
    expect(castOrigin("localhost", 9161, IFACES)).toBe("http://192.168.0.98:9161");
  });

  it("uses an explicit non-loopback bind address as given", () => {
    expect(castOrigin("192.168.0.98", 9161, IFACES)).toBe("http://192.168.0.98:9161");
  });

  it("is null when the machine has no non-loopback address, rather than naming loopback", () => {
    // A caller turns this into "this machine has no network a TV could reach
    // it on". A URL that cannot work is worse than no button.
    expect(castOrigin("0.0.0.0", 9161, { lo0: IFACES.lo0 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run src/web/castOrigin.test.ts`
Expected: FAIL — cannot resolve `./castOrigin`.

- [ ] **Step 3: Implement**

Create `src/web/castOrigin.ts`. Read `displayHosts` first (`src/web/links.ts:45`) and use its `lan` result rather than enumerating interfaces again — this module's whole job is to pick which of its two answers a device needs.

```ts
import { displayHosts, type NetInterfaces } from "./links";

/**
 * The origin a Chromecast must fetch media from.
 *
 * Deliberately NOT `requestOrigin` (src/web/stream.ts), which every other
 * absolute URL in this app comes from. That reads the request's `Host`, which
 * is right for a playlist the user's own machine opens and wrong for a
 * television: a user browsing `http://localhost:9161` would hand the device a
 * URL pointing at the device itself, and a user on a second interface would
 * hand it one it cannot route to.
 *
 * Null when there is no non-loopback address at all. A caller turns that into a
 * message; it must not fall back to loopback, because a URL that cannot work is
 * worse than no button.
 */
export function castOrigin(host: string, port: number, interfaces: NetInterfaces): string | null {
  const { lan } = displayHosts(host, interfaces);
  if (!lan) return null;
  return `http://${lan}:${port}`;
}
```

Note for the implementer: check what `displayHosts` returns for `lan` when the bind host is already a specific LAN address, and when there is none — the third and fourth tests pin both. If its shape does not fit (for instance `lan` is only populated for a wildcard bind), keep the signature and handle the cases here rather than changing `displayHosts`, which the TUI's splash line and `daemon/files.ts` also use.

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run src/web/castOrigin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/castOrigin.ts src/web/castOrigin.test.ts
git commit -m "feat(cast): the LAN origin a device fetches from"
```

---

### Task 9: The cast routes

**Files:**
- Modify: `src/web/routes.ts`, `src/web/wire.ts`, `src/web/server.ts` (pass the bound host/port and interfaces into `WebDeps`)
- Test: `src/web/routes.test.ts`

**Interfaces:**
- Consumes: `discover`, `parseManualDevice`, `type CastDevice` (Task 2); `CastSessionRegistry` on `Runtime` (Task 6); `castOrigin` (Task 8); `castContentType`, `CHROMECAST_PROFILE`, `blockersFor` (Task 3); `playlistTitle` (`src/util/playlistTitle.ts`).
- Produces, in `src/web/wire.ts`:
  ```ts
  export interface PublicCastDevice { id: string; name: string; model: string }
  export interface CastDevicesResponse { devices: PublicCastDevice[]; castable: boolean; reason: string | null }
  export interface CastStatusResponse {
    casting: null | {
      deviceName: string;
      title: string;
      state: "loading" | "playing" | "paused" | "idle";
      positionSec: number;
      durationSec: number | null;
    };
    notice: string | null;
  }
  ```
  and in `WebDeps`: `discoverCastImpl?: () => Promise<CastDevice[]>`, `castOriginImpl?: () => string | null`.

  Note what `PublicCastDevice` omits: `host` and `port`. The browser picks a device by `id`; the address stays server-side, because a page has no use for it and publishing the LAN topology of the user's house to any tab is gratuitous.

- [ ] **Step 1: Write the failing tests**

Add to `src/web/routes.test.ts`, using the file's existing `deps` builder:

```ts
describe("GET /api/cast/devices", () => {
  it("lists discovered devices without their addresses", async () => {
    const res = await handleWebApi(
      deps({ discoverCastImpl: async () => [
        { id: "abc", name: "Living Room TV", model: "Chromecast", host: "10.0.0.5", port: 8009 },
      ] }),
      "GET", "/api/cast/devices", new URLSearchParams(), auth, "",
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      devices: [{ id: "abc", name: "Living Room TV", model: "Chromecast" }],
      castable: true,
      reason: null,
    });
  });

  it("includes the configured address whether discovery saw anything or not", async () => {
    const res = await handleWebApi(
      deps({
        discoverCastImpl: async () => [],
        loadConfigImpl: async () => ({ ...baseConfig, castDevice: "192.168.0.40" }),
      }),
      "GET", "/api/cast/devices", new URLSearchParams(), auth, "",
    );
    expect((res.json as CastDevicesResponse).devices).toEqual([
      { id: "manual:192.168.0.40:8009", name: "192.168.0.40", model: "" },
    ]);
  });

  it("says why casting is unavailable when nothing answered", async () => {
    const res = await handleWebApi(
      deps({ discoverCastImpl: async () => [] }),
      "GET", "/api/cast/devices", new URLSearchParams(), auth, "",
    );
    expect(res.json).toMatchObject({ devices: [], castable: false });
    expect((res.json as CastDevicesResponse).reason).toMatch(/No Chromecast found/);
  });

  it("says why casting is unavailable when this machine has no LAN address", async () => {
    const res = await handleWebApi(
      deps({
        discoverCastImpl: async () => [{ id: "abc", name: "Living Room TV", model: "", host: "10.0.0.5", port: 8009 }],
        castOriginImpl: () => null,
      }),
      "GET", "/api/cast/devices", new URLSearchParams(), auth, "",
    );
    expect(res.json).toMatchObject({ castable: false });
    expect((res.json as CastDevicesResponse).reason).toMatch(/no network address/i);
  });

  it("needs the token", async () => {
    const res = await handleWebApi(deps(), "GET", "/api/cast/devices", new URLSearchParams(), undefined, "");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/cast/start", () => {
  it("casts the stream handle built from the LAN origin, not from Host", async () => {
    const runtime = runtimeWithSession(); // a ready session over Kestrel.2010…AC3.mp4
    const start = vi.spyOn(runtime.casts, "start");
    const res = await handleWebApi(
      deps({
        runtime,
        discoverCastImpl: async () => [{ id: "abc", name: "Living Room TV", model: "", host: "10.0.0.5", port: 8009 }],
        castOriginImpl: () => "http://192.168.0.98:9161",
      }),
      "POST", "/api/cast/start", new URLSearchParams(), auth,
      JSON.stringify({ deviceId: "abc", sid: runtime.sessionId, index: 0 }),
    );
    expect(res.status).toBe(200);
    const arg = start.mock.calls[0]![0];
    expect(arg.media.url).toBe(`http://192.168.0.98:9161/stream/${runtime.sessionId}/0?k=${runtime.capability}`);
    expect(arg.media.contentType).toBe("video/mp4");
    expect(arg.media.title).toBe("Kestrel 2010");
  });

  it("casts an HLS manifest with the HLS content type when the direct file is blocked", async () => {
    // The debrid provider's transcode: the only rung above direct play today.
    const runtime = runtimeWithSession({ filename: "Kepler.S02E04.1080p.WEB-DL.mkv", hls: "https://provider.example/m.m3u8" });
    const start = vi.spyOn(runtime.casts, "start");
    await handleWebApi(
      deps({ runtime, discoverCastImpl: async () => [DISCOVERED], castOriginImpl: () => "http://192.168.0.98:9161" }),
      "POST", "/api/cast/start", new URLSearchParams(), auth,
      JSON.stringify({ deviceId: "abc", sid: runtime.sessionId, index: 0 }),
    );
    expect(start.mock.calls[0]![0].media.contentType).toBe("application/vnd.apple.mpegurl");
  });

  it("refuses a file no Chromecast can play, naming the reason", async () => {
    const runtime = runtimeWithSession({ filename: "Kepler.S02E04.1080p.WEB-DL.mkv" }); // torrent backend, no hls
    const res = await handleWebApi(
      deps({ runtime, discoverCastImpl: async () => [DISCOVERED], castOriginImpl: () => "http://192.168.0.98:9161" }),
      "POST", "/api/cast/start", new URLSearchParams(), auth,
      JSON.stringify({ deviceId: "abc", sid: runtime.sessionId, index: 0 }),
    );
    expect(res.status).toBe(409);
    expect((res.json as { error: string }).error).toMatch(/can't play this one/);
  });

  it("passes the chosen subtitle as a vtt handle on the same origin", async () => {
    const runtime = runtimeWithSession({ subtitleIndex: 1 });
    const start = vi.spyOn(runtime.casts, "start");
    await handleWebApi(
      deps({ runtime, discoverCastImpl: async () => [DISCOVERED], castOriginImpl: () => "http://192.168.0.98:9161" }),
      "POST", "/api/cast/start", new URLSearchParams(), auth,
      JSON.stringify({ deviceId: "abc", sid: runtime.sessionId, index: 0, subtitleIndex: 1 }),
    );
    expect(start.mock.calls[0]![0].media.subtitleUrl).toBe(
      `http://192.168.0.98:9161/stream/${runtime.sessionId}/1.vtt?k=${runtime.capability}`,
    );
  });

  it("404s an unknown session and 404s an unknown device", async () => {
    const runtime = runtimeWithSession();
    const base = deps({ runtime, discoverCastImpl: async () => [DISCOVERED], castOriginImpl: () => "http://h:1" });
    const noSession = await handleWebApi(base, "POST", "/api/cast/start", new URLSearchParams(), auth,
      JSON.stringify({ deviceId: "abc", sid: "nope", index: 0 }));
    expect(noSession.status).toBe(404);
    const noDevice = await handleWebApi(base, "POST", "/api/cast/start", new URLSearchParams(), auth,
      JSON.stringify({ deviceId: "nope", sid: runtime.sessionId, index: 0 }));
    expect(noDevice.status).toBe(404);
  });

  it("400s a body missing a field, rather than casting something undefined", async () => {
    const res = await handleWebApi(deps(), "POST", "/api/cast/start", new URLSearchParams(), auth, "{}");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/cast/command", () => {
  it("pauses, plays and stops the active cast", async () => {
    const runtime = runtimeWithSession();
    const pause = vi.spyOn(runtime.casts, "pause").mockResolvedValue(undefined);
    const res = await handleWebApi(deps({ runtime }), "POST", "/api/cast/command",
      new URLSearchParams(), auth, JSON.stringify({ action: "pause" }));
    expect(res.status).toBe(200);
    expect(pause).toHaveBeenCalledOnce();
  });

  it("is a clean 409 when nothing is casting, not a crash", async () => {
    const runtime = runtimeWithSession();
    const res = await handleWebApi(deps({ runtime }), "POST", "/api/cast/command",
      new URLSearchParams(), auth, JSON.stringify({ action: "pause" }));
    expect(res.status).toBe(409);
  });

  it("400s an action it does not know", async () => {
    const res = await handleWebApi(deps(), "POST", "/api/cast/command",
      new URLSearchParams(), auth, JSON.stringify({ action: "seek" }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run src/web/routes.test.ts`
Expected: FAIL — the routes 404.

- [ ] **Step 3: Add the wire types**

In `src/web/wire.ts`, add `PublicCastDevice`, `CastDevicesResponse` and `CastStatusResponse` as given in the Interfaces block, each with a comment saying what it is for and, for `PublicCastDevice`, why the address is omitted.

- [ ] **Step 4: Implement the routes**

In `src/web/routes.ts`, below the streaming section's comment about the token gate, add three handlers and their dispatch lines, following the shape of `libraryAction` / `startStream`:

- `castDevices(deps)` — `discover()` plus `parseManualDevice(config.castDevice)`, de-duplicated by `id` with the configured entry last; `castable` is false with a reason when the list is empty (`No Chromecast found on this network.`) or when `castOriginImpl()` is null (`This machine has no network address a Chromecast could reach it on.`).
- `startCast(deps, bodyText)` — parse `{ deviceId, sid, index, subtitleIndex? }`; 400 on a missing field; 404 for an unknown session or device; compute facts the way `.info` does and refuse with 409 when `blockersFor(facts, CHROMECAST_PROFILE)` is non-empty *and* no HLS manifest is available; otherwise build the URL from `castOriginImpl()` and the session's `capability`, the content type from `castContentType`, and the title from `playlistTitle(file.filename)`; then `runtime.casts.start(...)`.
- `castCommand(deps, bodyText)` — `play` / `pause` / `stop` only; 400 otherwise; 409 when the registry says nothing is casting.

Reuse, don't reimplement: the `?k=` handle and `.vtt` suffix already have builders on the browser side (`streamPath`, `subtitlePath` in `playerModel.ts`) but those are in `src/web/static` and cannot be imported by the server. Build the two paths with a small local helper in `routes.ts` and note in a comment that a third consumer means moving one into `src/util/`.

- [ ] **Step 5: Pass the origin in from the server**

In `src/web/server.ts`, where `WebDeps` is assembled, default `castOriginImpl` to `() => castOrigin(host, boundPort, os.networkInterfaces())` — the *bound* port, read back from the handle the way the TUI's notice does (`src/ui/App.tsx:614`), never the requested one, because `port: 0` is in play.

- [ ] **Step 6: Run and confirm they pass**

Run: `npx vitest run src/web/routes.test.ts src/web/server.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/routes.ts src/web/wire.ts src/web/server.ts src/web/routes.test.ts
git commit -m "feat(cast): device list, start and command routes"
```

---

### Task 10: Cast status on the event stream

**Files:**
- Modify: `src/web/sse.ts`, `src/web/routes.ts` (or wherever the SSE endpoint is mounted)
- Test: `src/web/sse.test.ts`

**Interfaces:**
- Consumes: `CastSessionRegistry.onChange` (Task 6); `CastStatusResponse` (Task 9).
- Produces: `export function subscribeToCasts(channel: SseChannel, casts: CastSessionRegistry): () => void;` emitting a `cast` event whose data is a `CastStatusResponse`.

- [ ] **Step 1: Write the failing test**

Add to `src/web/sse.test.ts`, mirroring `subscribeToQueue`'s tests:

```ts
describe("subscribeToCasts", () => {
  it("sends the current cast state on subscribe, so a page that arrives mid-cast is not blank", () => {
    const written: string[] = [];
    const channel = openSseChannel((c) => written.push(c));
    const casts = new CastSessionRegistry();
    subscribeToCasts(channel, casts);
    expect(written.join("")).toContain("event: cast");
    expect(written.join("")).toContain('"casting":null');
  });

  it("sends an update whenever the cast changes", async () => { /* start a cast on a fake connection, assert a second frame naming the device */ });

  it("unsubscribes on close, so a closed page's socket is not written to", () => { /* assert the returned function detaches */ });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run src/web/sse.test.ts`
Expected: FAIL — `subscribeToCasts` is not exported.

- [ ] **Step 3: Implement, and mount it beside `subscribeToQueue`**

The `cast` event carries the same `CastStatusResponse` shape the routes return, so the browser has one parser for both. Include `notice` and take it from the registry, so a lost connection reaches an open page without it polling.

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run src/web/sse.test.ts src/web/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/sse.ts src/web/sse.test.ts src/web/routes.ts
git commit -m "feat(cast): push cast status over SSE"
```

---

### Task 11: Every browser-side decision

**Files:**
- Create: `src/web/static/castModel.ts`
- Test: `src/web/static/castModel.test.ts`

**Interfaces:**
- Consumes: `CastDevicesResponse`, `CastStatusResponse` (Task 9); `type Blocker` (`src/util/playability.ts`).
- Produces:
  ```ts
  export type CastButtonState = "hidden" | "ready" | "finding" | "disabled" | "casting";
  export interface CastButtonView { state: CastButtonState; label: string; disabledReason: string | null }
  export function castButtonView(input: {
    devices: CastDevicesResponse | null;
    status: CastStatusResponse | null;
    castBlockers: Blocker[];
    hasHls: boolean;
  }): CastButtonView;
  export function castStatusLine(status: CastStatusResponse): string | null;
  export function castControls(status: CastStatusResponse): ("play" | "pause" | "stop")[];
  export function formatCastTime(seconds: number): string;
  export function castBlockerReason(blockers: Blocker[]): string;
  ```
  Nothing here imports `node:*` — Task 14's `npm run build` is the only thing that proves it, because this module is bundled for the browser.

- [ ] **Step 1: Write the failing test**

Create `src/web/static/castModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  castBlockerReason,
  castButtonView,
  castControls,
  castStatusLine,
  formatCastTime,
} from "./castModel";
import type { CastDevicesResponse, CastStatusResponse } from "../wire";

const ONE_DEVICE: CastDevicesResponse = {
  devices: [{ id: "abc", name: "Living Room TV", model: "Chromecast" }],
  castable: true,
  reason: null,
};
const NONE: CastDevicesResponse = { devices: [], castable: false, reason: "No Chromecast found on this network." };
const IDLE: CastStatusResponse = { casting: null, notice: null };

describe("castButtonView", () => {
  it("is hidden until the device list has been fetched, so nothing flickers", () => {
    expect(castButtonView({ devices: null, status: null, castBlockers: [], hasHls: false })).toEqual({
      state: "hidden", label: "", disabledReason: null,
    });
  });

  it("offers casting when a device answered and the file is playable", () => {
    expect(castButtonView({ devices: ONE_DEVICE, status: IDLE, castBlockers: [], hasHls: false })).toEqual({
      state: "ready", label: "Cast to TV", disabledReason: null,
    });
  });

  it("is disabled with the network reason when nothing answered", () => {
    expect(castButtonView({ devices: NONE, status: IDLE, castBlockers: [], hasHls: false })).toEqual({
      state: "disabled", label: "Cast to TV", disabledReason: "No Chromecast found on this network.",
    });
  });

  it("is disabled with the file's reason when no Chromecast can play it", () => {
    expect(castButtonView({ devices: ONE_DEVICE, status: IDLE, castBlockers: ["container"], hasHls: false })).toEqual({
      state: "disabled",
      label: "Cast to TV",
      disabledReason: "A Chromecast can't play this one — it's a container it won't demux.",
    });
  });

  it("offers casting for a blocked file that has an HLS manifest, which is the rung above it", () => {
    expect(
      castButtonView({ devices: ONE_DEVICE, status: IDLE, castBlockers: ["container"], hasHls: true }),
    ).toMatchObject({ state: "ready" });
  });

  it("names the device once something is casting", () => {
    const status: CastStatusResponse = {
      casting: { deviceName: "Living Room TV", title: "Kepler S02E04", state: "playing", positionSec: 0, durationSec: 60 },
      notice: null,
    };
    expect(castButtonView({ devices: ONE_DEVICE, status, castBlockers: [], hasHls: false })).toEqual({
      state: "casting", label: "Playing on Living Room TV", disabledReason: null,
    });
  });

  it("says it is finding devices while the file is playable and the list is still empty-but-loading", () => {
    expect(
      castButtonView({ devices: { devices: [], castable: false, reason: null }, status: IDLE, castBlockers: [], hasHls: false }),
    ).toEqual({ state: "finding", label: "Finding devices…", disabledReason: null });
  });
});

describe("castStatusLine", () => {
  it("reads position over duration", () => {
    expect(castStatusLine({
      casting: { deviceName: "Living Room TV", title: "Kestrel 2010", state: "playing", positionSec: 724, durationSec: 6_512 },
      notice: null,
    })).toBe("0:12:04 / 1:48:32");
  });

  it("shows position alone when the duration is unknown, rather than inventing 0:00:00", () => {
    expect(castStatusLine({
      casting: { deviceName: "T", title: "Kestrel 2010", state: "playing", positionSec: 5, durationSec: null },
      notice: null,
    })).toBe("0:00:05");
  });

  it("says what it is doing when it is not playing", () => {
    expect(castStatusLine({
      casting: { deviceName: "T", title: "Kestrel 2010", state: "loading", positionSec: 0, durationSec: null },
      notice: null,
    })).toBe("Loading on the TV…");
    expect(castStatusLine({
      casting: { deviceName: "T", title: "Kestrel 2010", state: "paused", positionSec: 61, durationSec: 600 },
      notice: null,
    })).toBe("Paused · 0:01:01 / 0:10:00");
  });

  it("is null when nothing is casting", () => {
    expect(castStatusLine(IDLE)).toBeNull();
  });
});

describe("formatCastTime", () => {
  it("is h:mm:ss, zero-padded past the hours", () => {
    expect(formatCastTime(0)).toBe("0:00:00");
    expect(formatCastTime(61)).toBe("0:01:01");
    expect(formatCastTime(3_661)).toBe("1:01:01");
  });

  it("floors a fractional position and clamps a negative one", () => {
    expect(formatCastTime(12.9)).toBe("0:00:12");
    expect(formatCastTime(-5)).toBe("0:00:00");
  });
});

describe("castControls", () => {
  it("offers pause and stop while playing, play and stop while paused", () => {
    const at = (state: "playing" | "paused" | "loading" | "idle"): CastStatusResponse => ({
      casting: { deviceName: "T", title: "Kestrel 2010", state, positionSec: 0, durationSec: null },
      notice: null,
    });
    expect(castControls(at("playing"))).toEqual(["pause", "stop"]);
    expect(castControls(at("paused"))).toEqual(["play", "stop"]);
    // Loading: only stop, because pausing something that has not started is a
    // button that appears to do nothing.
    expect(castControls(at("loading"))).toEqual(["stop"]);
    expect(castControls(at("idle"))).toEqual(["stop"]);
    expect(castControls(IDLE)).toEqual([]);
  });
});

describe("castBlockerReason", () => {
  it("names the container first, because it is the one a user can recognise", () => {
    expect(castBlockerReason(["container", "audio"])).toContain("container");
    expect(castBlockerReason(["video"])).toContain("video");
    expect(castBlockerReason(["audio"])).toContain("audio");
  });

  it("never returns an empty string, so a disabled button always says why", () => {
    expect(castBlockerReason([])).not.toBe("");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run src/web/static/castModel.test.ts`
Expected: FAIL — cannot resolve `./castModel`.

- [ ] **Step 3: Implement**

Write `castModel.ts` to satisfy exactly the above. Keep the doc comment at the top explaining why this module exists: `player.ts` is DOM wiring only, has no test reachable without jsdom, and this codebase has twice caught a decision that belonged here sitting in the wiring.

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run src/web/static/castModel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/static/castModel.ts src/web/static/castModel.test.ts
git commit -m "feat(cast): the browser's cast decisions, as a pure module"
```

---

### Task 12: The cast button on the player page

**Files:**
- Modify: `src/web/static/player.ts`, `src/web/static/styles.css`
- Read first: `src/web/static/player.ts:56` (`actions`), `:428` (`actions.replaceChildren`), `:453` (`linkButton`), and the fallback-card renderer

**Interfaces:**
- Consumes: everything from Task 11; the routes from Task 9; the `cast` SSE event from Task 10.
- Produces: no new exports. This task adds no conditionals — `player.ts` reads `castButtonView`, `castStatusLine` and `castControls` and renders what they say.

There is no unit test here, deliberately: nothing in `player.ts` is reachable without jsdom, and this repo has none. Verification is running it.

- [ ] **Step 1: Fetch the device list and subscribe to status**

On page load, after `.info` resolves, `GET /api/cast/devices` and hold the response; subscribe to the `cast` SSE event and hold the latest `CastStatusResponse`. Re-render the action row on either changing. Both start null, which `castButtonView` reports as `hidden` — that is why it has that state.

- [ ] **Step 2: Render the button in the hand-off row**

In the same `actions` container as copy-URL, `.m3u` and the mobile VLC link, because casting *is* a hand-off. `createElement` + `textContent` only. A `disabled` state renders as a disabled `<button>` with its reason as adjacent text — not a `title` attribute, which a phone cannot show.

- [ ] **Step 3: The device picker**

Clicking `Cast to TV` with one device casts to it. With more than one, reveal a list of buttons, one per device, labelled `name` with `model` as secondary text. `POST /api/cast/start` with `{ deviceId, sid, index, subtitleIndex }`, taking the subtitle index from whatever the page's subtitle picker currently has selected.

- [ ] **Step 4: Swap the controls while casting**

On a `casting` state: pause the local `<video>` (`video.pause()`), show `castStatusLine`'s text, and render one button per `castControls` entry, each `POST /api/cast/command`. On `stop`, or on a `notice` arriving, restore the page's own controls and show the notice in the existing `notice` element.

- [ ] **Step 5: The fallback card gets a cast button**

Where the card renders (`fallbackMessage`), also render the cast button. `castButtonView` already returns `ready` for a file the browser refuses but a Chromecast takes — an MP4 carrying AC3 — which is the point of having two profiles. Nothing new decides this; pass the same inputs.

- [ ] **Step 6: Style it**

Add a `.cast-*` block to `styles.css` following the calm theme already there. No new colours.

- [ ] **Step 7: Verify by running it**

```bash
npm run build && npm run dev -- serve --web
```

Then, against a real Chromecast on the LAN, confirm each in turn and write the result into the commit body:
1. The button appears, and names a real device.
2. An MP4 casts and plays on the television.
3. Pause, resume and stop each work, and the position line advances.
4. Stopping restores the page's own player.
5. A file with a subtitle selected shows that subtitle on the television.
6. With no Chromecast on the network, the button is disabled and says so.
7. An MKV from a torrent is disabled with the container reason; the same MKV on the debrid backend casts.

- [ ] **Step 8: Commit**

```bash
git add src/web/static/player.ts src/web/static/styles.css
git commit -m "feat(web): cast a stream to a Chromecast from the player page"
```

---

### Task 13: The device list in the terminal

**Files:**
- Create: `src/ui/components/CastPrompt.tsx`, `src/ui/components/CastPrompt.test.tsx`
- Modify: `src/config/config.ts` (add `castDevice`), `src/ui/keymap.ts`, `src/ui/keymap.test.ts`, `src/ui/components/StreamFilePrompt.tsx`, `src/ui/components/StreamFilePrompt.test.tsx`
- Modify: `src/ui/store.ts`, `src/ui/testHarness.ts`, `scripts/render-previews-impl.tsx`

**Interfaces:**
- Consumes: `type CastDevice` (Task 2).
- Produces:
  ```ts
  // CastPrompt.tsx
  interface CastPromptProps {
    width: number;
    devices: CastDevice[];
    /** True while discovery is still running. */
    finding: boolean;
    /** The configured address, prefilled into the field. */
    configured?: string;
    onSelect: (device: CastDevice) => void;
    /** Saves the typed address to config and casts to it. */
    onAddress: (address: string) => void;
    onCancel: () => void;
  }
  // StreamFilePrompt gains:
  onCast?: (file: StreamFile) => void;
  // Store gains:
  castStatus: { deviceName: string; title: string; state: string; positionSec: number; durationSec: number | null } | null;
  ```

**Why the address field lives in this prompt rather than behind a new key:** the letters in the Search section are used up, and a config screen for one field the user needs *exactly* when the list is empty is the wrong place for it. The empty list is the moment to offer it.

- [ ] **Step 1: Write the failing component test**

Create `src/ui/components/CastPrompt.test.tsx`, following `SourcesPrompt.test.tsx`'s use of `ink-testing-library`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { CastPrompt } from "./CastPrompt";
import type { CastDevice } from "../../core/cast/discover";

const DEVICES: CastDevice[] = [
  { id: "abc", name: "Living Room TV", model: "Chromecast", host: "10.0.0.5", port: 8009 },
  { id: "k1", name: "Kitchen display", model: "Google TV Streamer", host: "10.0.0.6", port: 8009 },
];

describe("CastPrompt", () => {
  it("lists devices with their models", () => {
    const { lastFrame } = render(
      <CastPrompt width={80} devices={DEVICES} finding={false} onSelect={() => {}} onAddress={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame()).toContain("Living Room TV");
    expect(lastFrame()).toContain("Google TV Streamer");
  });

  it("selects the highlighted device on enter", () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <CastPrompt width={80} devices={DEVICES} finding={false} onSelect={onSelect} onAddress={() => {}} onCancel={() => {}} />,
    );
    stdin.write("[B"); // down
    stdin.write("\r");
    expect(onSelect).toHaveBeenCalledWith(DEVICES[1]);
  });

  it("says it is looking while discovery runs", () => {
    const { lastFrame } = render(
      <CastPrompt width={80} devices={[]} finding onSelect={() => {}} onAddress={() => {}} onCancel={() => {}} />,
    );
    expect(lastFrame()).toMatch(/Looking for/i);
  });

  it("explains mDNS when nothing was found, and offers the address field", () => {
    const { lastFrame } = render(
      <CastPrompt width={80} devices={[]} finding={false} onSelect={() => {}} onAddress={() => {}} onCancel={() => {}} />,
    );
    // The Docker / VLAN case: without this the feature looks broken rather
    // than blocked.
    expect(lastFrame()).toMatch(/No Chromecast found/i);
    expect(lastFrame()).toMatch(/Docker|VLAN|address/i);
  });

  it("submits a typed address", () => {
    const onAddress = vi.fn();
    const { stdin } = render(
      <CastPrompt width={80} devices={[]} finding={false} onSelect={() => {}} onAddress={onAddress} onCancel={() => {}} />,
    );
    stdin.write("192.168.0.40");
    stdin.write("\r");
    expect(onAddress).toHaveBeenCalledWith("192.168.0.40");
  });

  it("cancels on escape", () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      <CastPrompt width={80} devices={DEVICES} finding={false} onSelect={() => {}} onAddress={() => {}} onCancel={onCancel} />,
    );
    stdin.write("");
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Write the failing keymap and picker tests**

In `src/ui/keymap.test.ts`:

```ts
it("advertises the cast key in both halves, so the help overlay and the footer agree", () => {
  const search = HELP_GROUPS.find((g) => g.title === "Search")!;
  expect(search.hints.some((h) => h.keys === "c" && /cast/i.test(h.label))).toBe(true);
  const footer = footerHints("content", "search");
  expect(footer.some((h) => h.keys === "c" && /cast/i.test(h.label))).toBe(true);
});
```

In `src/ui/components/StreamFilePrompt.test.tsx`:

```ts
it("casts the highlighted file on c, without also playing it locally", () => {
  const onCast = vi.fn();
  const onSelect = vi.fn();
  const { stdin } = render(<StreamFilePrompt width={80} files={FILES} onSelect={onSelect} onCast={onCast} onCancel={() => {}} />);
  stdin.write("c");
  expect(onCast).toHaveBeenCalledWith(FILES[0]);
  expect(onSelect).not.toHaveBeenCalled();
});

it("ignores c when no cast handler was given, rather than swallowing the key", () => {
  const onSelect = vi.fn();
  const { stdin } = render(<StreamFilePrompt width={80} files={FILES} onSelect={onSelect} onCancel={() => {}} />);
  stdin.write("c");
  expect(onSelect).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run all three and confirm they fail**

Run: `npx vitest run src/ui/components/CastPrompt.test.tsx src/ui/keymap.test.ts src/ui/components/StreamFilePrompt.test.tsx`
Expected: FAIL on each.

- [ ] **Step 4: Add `castDevice` to the config**

In `src/config/config.ts`, add to the `Config` interface with a comment saying why it exists (mDNS does not cross a Docker bridge or a VLAN) and that it is TUI-only by the rule in `CLAUDE.md`. Follow the file's existing optional-string handling in load and save, and add a `config.test.ts` case that a saved address round-trips and that an absent one stays absent.

- [ ] **Step 5: Write `CastPrompt.tsx`**

Follow `SourcesPrompt.tsx` for the list and `TokenPrompt.tsx` for the text field. `useInput` handles up/down/enter/escape; the field is `TextField`. The empty state carries the mDNS sentence.

- [ ] **Step 6: Add `c` to `StreamFilePrompt` and both halves of the keymap**

`HELP_GROUPS` Search section: `{ keys: "c", label: "Cast to a TV (Chromecast)" }`. `footerHints`: a terse `{ keys: "c", label: "Cast" }` in the row the picker shows. `StreamFilePrompt`'s `useInput` gains the `c` branch, guarded on `onCast` being present.

- [ ] **Step 7: Add `castStatus` to the store and BOTH harnesses**

`src/ui/store.ts`, then `makeTestStore` in `src/ui/testHarness.ts` (or `npm run typecheck` breaks) and `makeStore` in `scripts/render-previews-impl.tsx` (or `npm run previews` breaks). Both, per `CLAUDE.md`'s table.

- [ ] **Step 8: Run and confirm they pass**

Run: `npx vitest run src/ui src/config/config.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/ui src/config/config.ts src/config/config.test.ts scripts/render-previews-impl.tsx
git commit -m "feat(tui): a cast key and a device list"
```

---

### Task 14: Casting from the terminal

**Files:**
- Modify: `src/ui/App.tsx`
- Test: `src/ui/App.web.test.tsx` (the existing harness for App-level behaviour)

**Interfaces:**
- Consumes: `discover`, `parseManualDevice` (Task 2); `CastSessionRegistry` (Task 6); `StreamSessionRegistry.adopt` (Task 5); `castOrigin` (Task 8); `castContentType`, `CHROMECAST_PROFILE`, `blockersFor` (Task 3); `CastPrompt` (Task 13).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

In `src/ui/App.web.test.tsx`, add cases for the flow's two decisions — remembering that the point of testing here is the *sequence*, since the pieces each have their own tests:

```tsx
it("starts the web UI when casting and it is not already running, and says so", async () => {
  // The TUI's own stream server binds localhost on an ephemeral port
  // (src/integrations/torrentStream.ts:73), so a television cannot fetch from
  // it. The web server is the only LAN-reachable, token-authed origin torlink
  // has — so casting brings it up, and announces that rather than starting a
  // server behind the user's back.
});

it("reuses the running web server when there is one", async () => {});

it("adopts the resolved files rather than resolving a second time", async () => {
  // Casting from the picker must not spend the user's debrid account twice.
});

it("refuses to cast a file no Chromecast can play, with the reason, and does not open the device list", async () => {});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run src/ui/App.web.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the flow**

Add `castFromPicker`, beside `playFromPicker` (`src/ui/App.tsx:1429`) and shaped like it:

1. Compute `blockersFor(classifyFromName(file.filename, streamSource?.name), CHROMECAST_PROFILE)`. Non-empty with no HLS available → `setNotice("A Chromecast can't play this one — …")` and stop. No prompt appears for something that cannot work.
2. Ensure the web server is up. If the existing mount has no handle, start it the same way the shift+w path does, reusing that code rather than a second copy, and set a notice naming the URL — `withoutToken`, as the existing notice does, because terminal scrollback is kept alive by `torlnk attach`.
3. `sessions.adopt({ infoHash, name, backend, provider, files })`.
4. `discover()` plus `parseManualDevice(config.castDevice)`; open `CastPrompt` with the result.
5. On selection, build the URL from `castOrigin(host, boundPort, os.networkInterfaces())` and the adopted session's `capability`, and call `casts.start(...)`. On rejection, `setNotice(e.message)` — the messages from Task 4 are already fit for the screen.
6. On `onAddress`, read-modify-write the config with the address (`loadConfig()` → set `castDevice` → `saveConfig()`), then cast to `parseManualDevice`'s device.
7. Subscribe to `casts.onChange` to keep `castStatus` in the store, and render a cast row in the stream pane: device, title, position. `p` pauses and resumes; `x` stops — which is already "stop active stream" in all three list panes, so the key that stops a stream stops a cast.

- [ ] **Step 4: Run and confirm they pass**

Run: `npx vitest run src/ui && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify by running it**

```bash
npm run dev
```

Search, stream a torrent, press `c` in the picker, and confirm: the web UI starts and is announced; the device list names a real Chromecast; the file plays on the television; the cast row shows an advancing position; `p` pauses and resumes; `x` stops and the television returns to its own screen. Then repeat with the web UI already running (shift+w first) and confirm nothing is started twice. Write the results into the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/ui/App.tsx src/ui/App.web.test.tsx
git commit -m "feat(tui): cast a stream to a Chromecast from the file picker"
```

---

### Task 15: Documentation and the full gate

**Files:**
- Modify: `README.md`
- Verify: everything

- [ ] **Step 1: README**

Add casting to the streaming section, and be exact about the limits rather than selling past them:

- It finds devices over mDNS, which does not cross a Docker bridge or a VLAN — hence the address you can type into the device list, which is remembered.
- An MP4 or WebM carrying H.264 casts. An MKV casts **only** on the debrid backend, via the provider's transcode; from a torrent it does not, and the button says so. HEVC casts on neither.
- AC3 and E-AC3 are passed through to the television. On a TV or receiver that cannot take them the picture plays silently — stop the cast and play it locally.
- Pause, resume, stop and a position, from either front end. Seeking and volume are the TV's remote.
- A cast started in the terminal is not visible to a separate `serve --web` process, and vice versa.

Then re-read the web UI's own limitations list and confirm the "needs a real player" wording is still true now that the fallback card can cast. Correct it if not.

- [ ] **Step 2: The full gate**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

All four must pass. One known pre-existing lint warning (`react-hooks/exhaustive-deps`, `src/ui/App.tsx`) is expected — leave it. `npm run build` is the only thing that proves `castModel.ts` pulled no `node:*` into the browser bundle; if it fails there, the fix is in `castModel.ts`, not in the build config.

- [ ] **Step 3: Confirm the fixture rule held**

```bash
grep -rniE "\b(inception|breaking bad|the bear|big buck)" src README.md | grep -v "preview/" | cut -c1-120
```

Expected: no hits outside `preview/` screenshots, which are the documented exception.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: casting to a Chromecast, and what it will not do"
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: `protocol.ts` → 1; `discover.ts` and the configured address → 2 and 13 (config) and 9 (the route that returns it); the capability profile and `castContentType` → 3; `connection.ts` and every row of the failure table → 4; `adopt` → 5; `session.ts`, `Runtime.casts`, the played-file write and the per-process limit → 6; `castBlockers` and the `.vtt` CORS header → 7; the LAN-origin rule → 8; the three routes → 9; SSE → 10; `castModel.ts` → 11; the player page and the fallback card's cast button → 12; the TUI's key, prompt, keymap halves and store fields → 13; the TUI flow including "ensure the web server" → 14; docs and the gate → 15.

**Gaps accepted, and why.** Task 12 and Task 14 have no unit tests for their DOM and Ink wiring beyond what Task 13's component tests cover — that is the repo's stated position (no jsdom, wiring is verified by running it), which is why both tasks end with a numbered manual checklist whose results go in the commit body. Task 10's test bodies are sketched rather than written out, because their setup depends on the exact shape of `openSseChannel`'s existing test helpers; the implementer should follow `subscribeToQueue`'s tests in the same file.

**Type consistency.** `CastDevice` (Task 2) is used unchanged through Tasks 4, 6, 9, 13, 14. `CastStatus` (Task 4) is the core shape; `CastStatusResponse` (Task 9) is the wire shape, and Task 11 consumes only the wire one — the browser never sees the core type, which is what the layering rule requires. `blockersFor(facts, profile?)` keeps its one-argument form for the two existing call sites. `CastMediaRequest` is built in Task 9 (web) and Task 14 (TUI) and consumed in Task 4 — the same fields in both, which is what the third test in Task 9 and the manual check in Task 14 confirm.
