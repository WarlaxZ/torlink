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

export interface MdnsRecord {
  name: string;
  type: string;
  data: unknown;
}

export interface MdnsPacket {
  answers?: MdnsRecord[];
  additionals?: MdnsRecord[];
}

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
    const addressed = records.find(
      (r) => (r.type === "A" || r.type === "AAAA") && r.name === target,
    );
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
    mdns.on("response", (packet) => {
      packets.push(packet);
    });
    mdns.query({ questions: [{ name: CAST_SERVICE, type: "PTR" }] });
    await sleep(timeoutMs);
  } catch {
    // No multicast route, a firewall, a container with no host network: an
    // empty list and a message the caller can explain, never a thrown error
    // in the middle of someone pressing a button.
  } finally {
    try {
      mdns.destroy();
    } catch {
      // Already gone. Nothing to reclaim.
    }
  }
  return devicesFromPackets(packets);
}
