import { displayHosts, type NetInterfaces } from "./links";

/**
 * Addresses that mean "this machine only". A device on the LAN cannot reach any
 * of them, whatever URL it is handed.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * The origin a Chromecast must fetch media from.
 *
 * Deliberately NOT `requestOrigin` (./stream.ts), which every other absolute URL
 * in this app comes from. That reads the request's `Host`, which is right for a
 * playlist the user's own machine opens and wrong for a television: a user
 * browsing `http://localhost:9161` would hand the device a URL pointing at the
 * device itself, and a user reaching the server over one interface would hand it
 * one it may not route to.
 *
 * So this keys off the address the server was BOUND to, which is a fact about
 * what is reachable rather than a claim by a client.
 *
 * Null in the two cases where casting genuinely cannot work, and null rather
 * than a guess in both, because a URL that cannot answer is worse than a button
 * that says why:
 *
 * - A loopback bind. Nothing on the LAN can reach the server at all, so naming
 *   the machine's LAN address would produce a cast that fails silently on the
 *   device with no explanation on screen.
 * - A wildcard bind on a machine with no non-loopback IPv4 address.
 *
 * `advertise` overrides the whole guess, and is the escape hatch for a host whose
 * own interfaces are the wrong answer. WSL2 in its default NAT mode is the case
 * it was added for: inside the VM `eth0` is a `172.x` address that looks entirely
 * plausible here and is unroutable from the LAN, so a cast would fail on the
 * television as "couldn't play this file" — blaming the file for a network
 * problem. Bridged Docker is the same shape. It is a setting rather than a
 * heuristic because nothing observable from inside the VM distinguishes "my
 * address" from "the address a TV should use"; only the person who configured the
 * port forwarding knows.
 */
export function castOrigin(
  host: string,
  port: number,
  interfaces: NetInterfaces,
  advertise?: string,
): string | null {
  // The override first, because it exists precisely for the case where this
  // machine's own interfaces are the WRONG answer and nothing here can tell.
  const named = parseAdvertised(advertise, port);
  if (named.kind === "origin") return named.value;
  if (named.kind === "refuse") return null;
  const trimmed = host.trim();
  if (LOOPBACK_HOSTS.has(trimmed.toLowerCase())) return null;
  const { local, lan } = displayHosts(trimmed, interfaces);
  // `displayHosts` answers a wildcard bind with loopback as `local` and the LAN
  // addresses beside it; anything else it answers with the bound address itself,
  // bracketed if it is an IPv6 literal.
  if (local === "127.0.0.1") {
    const first = lan[0];
    return first ? `http://${first}:${port}` : null;
  }
  return `http://${local}:${port}`;
}

/**
 * What a configured advertised host means.
 *
 * Three answers, not two: "nothing was configured" and "what was configured
 * cannot work" must behave differently. The first falls back to the guess; the
 * second refuses outright, because quietly ignoring a setting the user
 * deliberately wrote is how a cast fails with no explanation on either screen.
 */
type Advertised =
  | { kind: "origin"; value: string }
  | { kind: "refuse" }
  | { kind: "none" };

/**
 * Split `host`, `host:port`, `[v6]` or `[v6]:port`.
 *
 * A bare IPv6 literal is ALL colons, so a trailing `:5` in `2001:db8::5` is a
 * hextet and not a port — which is why an IPv6 host must be bracketed to carry
 * one. Getting this wrong produced `http://[2001:db8:]:5`.
 */
function splitAdvertised(raw: string): { host: string; port: number | null } | null {
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(raw);
  if (bracketed) {
    return { host: bracketed[1]!, port: bracketed[2] ? Number(bracketed[2]) : null };
  }
  // Two or more colons can only be IPv6, and unbracketed IPv6 carries no port.
  if ((raw.match(/:/g) ?? []).length >= 2) return { host: raw, port: null };
  const withPort = /^([^:]+):(\d+)$/.exec(raw);
  if (withPort) return { host: withPort[1]!, port: Number(withPort[2]) };
  // A trailing colon with a non-numeric port ("tv.local:nope") is a typo.
  if (raw.includes(":")) return null;
  return { host: raw, port: null };
}

function parseAdvertised(raw: string | undefined, defaultPort: number): Advertised {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { kind: "none" };
  const split = splitAdvertised(trimmed);
  // A typo falls back to the guess rather than refusing: the guess is right on
  // most hosts, and this setting is only ever needed on a minority of them.
  if (!split || !split.host) return { kind: "none" };
  const port = split.port ?? defaultPort;
  if (port < 1 || port > 65_535) return { kind: "none" };
  // Loopback cannot be what anyone meant: it is the one answer guaranteed to be
  // wrong for a television. Refused rather than ignored, so the UI says why.
  if (LOOPBACK_HOSTS.has(split.host.toLowerCase())) return { kind: "refuse" };
  const host = split.host.includes(":") ? `[${split.host}]` : split.host;
  return { kind: "origin", value: `http://${host}:${port}` };
}
