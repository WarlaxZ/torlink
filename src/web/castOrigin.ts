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
 */
export function castOrigin(
  host: string,
  port: number,
  interfaces: NetInterfaces,
): string | null {
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
