import { Agent, type Dispatcher } from "undici";

// Optional custom DNS via DNS-over-HTTPS (DoH). Some networks sinkhole torrent
// domains — and many do it by transparently intercepting *all* port-53 traffic,
// so pointing at a different plain resolver (even 1.1.1.1) doesn't help. DoH
// resolves over HTTPS on :443, which those filters can't touch, and the actual
// content fetch then connects straight to the real IP (the block is DNS-only).
// This only affects torlink's own fetch()es; system DNS is untouched.

// Friendly names for common public resolvers.
const ALIASES: Record<string, string[]> = {
  cloudflare: ["1.1.1.1", "1.0.0.1"],
  google: ["8.8.8.8", "8.8.4.4"],
  quad9: ["9.9.9.9", "149.112.112.112"],
  opendns: ["208.67.222.222", "208.67.220.220"],
};

/**
 * Parse a comma-separated DNS spec into resolver IPs. Accepts raw IPv4/IPv6
 * addresses and the aliases above (case-insensitive); blank entries are dropped,
 * unknown ones passed through trimmed so a typo is visible rather than swallowed.
 */
export function parseDnsServers(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").flatMap((part) => {
    const p = part.trim();
    if (!p) return [];
    return ALIASES[p.toLowerCase()] ?? [p];
  });
}

// The JSON-DoH endpoint for a resolver IP. Google serves it at /resolve; almost
// everyone else (Cloudflare included) uses /dns-query. Both speak the same
// application/dns-json format.
export function dohEndpoint(server: string): string {
  const path = server === "8.8.8.8" || server === "8.8.4.4" ? "resolve" : "dns-query";
  return `https://${server}/${path}`;
}

interface DohAnswer {
  type: number;
  data: string;
  TTL: number;
}

interface Resolved {
  address: string;
  family: 4 | 6;
}

const A = 1;
const AAAA = 28;
const MIN_TTL_MS = 60_000;

// Small in-memory cache so we don't DoH-resolve on every single connection.
const cache = new Map<string, { addrs: Resolved[]; expires: number }>();

async function dohQuery(endpoint: string, hostname: string, rrtype: number): Promise<DohAnswer[]> {
  const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=${rrtype === AAAA ? "AAAA" : "A"}`;
  // Plain global fetch, straight to the resolver's IP — no DNS lookup needed to
  // reach it, and it deliberately does NOT use our custom dispatcher (no loop).
  const res = await fetch(url, { headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DoH ${res.status}`);
  const json = (await res.json()) as { Answer?: DohAnswer[] };
  return (json.Answer ?? []).filter((a) => a.type === rrtype);
}

async function resolveViaDoh(endpoints: string[], hostname: string): Promise<Resolved[]> {
  const hit = cache.get(hostname);
  if (hit && hit.expires > Date.now()) return hit.addrs;

  let lastErr: unknown;
  for (const endpoint of endpoints) {
    try {
      let recs = await dohQuery(endpoint, hostname, A);
      let family: 4 | 6 = 4;
      if (recs.length === 0) {
        recs = await dohQuery(endpoint, hostname, AAAA);
        family = 6;
      }
      if (recs.length > 0) {
        const addrs = recs.map((r) => ({ address: r.data, family }));
        const ttlMs = Math.max(MIN_TTL_MS, Math.min(...recs.map((r) => r.TTL)) * 1000);
        cache.set(hostname, { addrs, expires: Date.now() + ttlMs });
        return addrs;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`DoH could not resolve ${hostname}`);
}

let dispatcher: Dispatcher | undefined;

/**
 * Install (or clear) a DoH-backed dispatcher for torlink's fetches. Empty list
 * falls back to the system resolver. Idempotent; safe to call on boot and again
 * whenever the setting changes.
 */
export function setDnsServers(servers: readonly string[]): void {
  if (servers.length === 0) {
    dispatcher = undefined;
    return;
  }
  const endpoints = servers.map(dohEndpoint);
  dispatcher = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        resolveViaDoh(endpoints, hostname)
          .then((addrs) => {
            const wanted = options?.family === 6 ? addrs.filter((a) => a.family === 6) : addrs;
            const use = wanted.length > 0 ? wanted : addrs;
            if (options?.all) {
              callback(null, use as never);
            } else {
              callback(null, use[0]!.address as never, use[0]!.family as never);
            }
          })
          .catch((err: Error) => callback(err, null as never, 0 as never));
      },
    },
  });
}

/** The active custom-DNS dispatcher, or undefined when using system DNS. */
export function getDnsDispatcher(): Dispatcher | undefined {
  return dispatcher;
}
