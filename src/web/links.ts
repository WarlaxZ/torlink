// Turning a bind address into an address a human can open.
//
// These are not the same string, and the whole reason this module exists is that
// treating them as the same shipped a bug: `--host 0.0.0.0` was printed straight
// into the startup log as `http://0.0.0.0:9161`, which resolves to loopback on
// Linux by accident of the resolver and fails outright from Windows or a phone.
// A user pastes it, gets nothing, and concludes the web UI did not start.
//
// Pure on purpose: the interface list is a parameter, so the whole module tests
// without depending on which NICs the developer's machine happens to have.

/** The part of `os.networkInterfaces()` output this module reads. */
export interface NetAddress {
  /** "IPv4" / "IPv6" on modern Node; older builds reported 4 / 6. */
  family: string | number;
  address: string;
  internal: boolean;
}

export type NetInterfaces = Record<string, NetAddress[] | undefined>;

/**
 * Addresses that mean "every interface". None of them is reachable as itself:
 * a wildcard says where to listen, and says nothing about where to connect.
 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*", ""]);

/**
 * The browsable host(s) for a bind address: one to hand the local machine, and
 * the LAN addresses to hand anything else.
 *
 * A wildcard yields loopback plus every external IPv4. IPv6 is deliberately
 * left out of the LAN list — link-local addresses (`fe80::…`) need a scope id to
 * be usable and would be noise in a startup log.
 */
export function displayHosts(
  bindHost: string,
  interfaces: NetInterfaces,
): { local: string; lan: string[] } {
  const host = bindHost.trim();
  if (!WILDCARD_HOSTS.has(host)) return { local: bracket(host), lan: [] };

  const lan: string[] = [];
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      lan.push(entry.address);
    }
  }
  return { local: "127.0.0.1", lan };
}

// An IPv6 literal must be bracketed inside a URL or the port reads as another
// hextet. The colon is a safe detector: no hostname or IPv4 address contains one.
function bracket(host: string): string {
  if (!host.includes(":")) return host;
  return host.startsWith("[") ? host : `[${host}]`;
}

/**
 * The URL to open. A token rides in the *fragment*, not the query string: a
 * fragment never leaves the browser, so the secret stays out of the server's
 * access log and out of any `Referer` a click on the link generates.
 */
export function webUrl(host: string, port: number, token?: string): string {
  const base = `http://${host}:${port}`;
  return token ? `${base}/#k=${encodeURIComponent(token)}` : base;
}
