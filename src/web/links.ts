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
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "::0", "[::]", "*", ""]);

/**
 * The browsable host(s) for a bind address: one to hand the local machine, and
 * the LAN addresses to hand anything else.
 *
 * A wildcard yields loopback plus every external IPv4. The LAN list is IPv4
 * only, deliberately and including global IPv6 — not just the link-local
 * `fe80::…` addresses that would need a scope id to be usable at all. Most
 * machines hold several v6 addresses (SLAAC, privacy extensions, a ULA) that all
 * reach the same host, so listing them turns a two-line "here is where to go"
 * into a wall nobody reads.
 *
 * The cost is real and worth stating: on a v6-only LAN this prints a loopback
 * link and no LAN line at all, which reads as "nothing was exposed" when
 * something was. The bind line above it still names the address that was bound,
 * so the truth is on screen — but if v6-only setups ever matter here, this is
 * the decision to revisit.
 */
export function displayHosts(
  bindHost: string,
  interfaces: NetInterfaces,
): { local: string; lan: string[] } {
  const host = bindHost.trim();
  if (!WILDCARD_HOSTS.has(host)) return { local: bracket(host), lan: [] };

  // A Set dedupes: two interfaces (a bridge and its physical parent, a VLAN
  // and its base NIC) can legitimately report the same address, and printing
  // it twice would look like a bug in this module rather than the machine's
  // networking.
  const lan = new Set<string>();
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      lan.add(entry.address);
    }
  }
  return { local: "127.0.0.1", lan: [...lan] };
}

// An IPv6 literal must be bracketed inside a URL or the port reads as another
// hextet. The colon is a safe detector: the input to this function is always
// a bare hostname or IPv4 address (which never contain one) or an IPv6
// literal (which always does).
function bracket(host: string): string {
  if (!host.includes(":")) return host;
  return host.startsWith("[") ? host : `[${host}]`;
}

/**
 * The URL to open. A token rides in the *fragment*, not the query string: a
 * fragment never leaves the browser, so the secret stays out of the server's
 * access log and out of any `Referer` a click on the link generates. Note the
 * trailing slash before the fragment is deliberate — the no-token branch has
 * no slash, so the two forms are not otherwise comparable as strings.
 *
 * `host` is bracketed here even though `displayHosts` already brackets its
 * `local` result: `bracket` is idempotent, and calling it again is cheaper
 * than requiring every caller to know which upstream function already did it.
 * A caller that skips `displayHosts` and hands a raw IPv6 literal straight to
 * `webUrl` — which is exactly what happens at the call sites this module
 * exists to fix — still gets a working URL instead of `http://::1:9161`.
 */
/**
 * The same URL with the token elided — for anywhere it is *displayed* rather
 * than followed.
 *
 * The TUI's splash is the case that needs it: a full link there puts the secret
 * into terminal scrollback for the whole session, and `torlnk attach` keeps that
 * scrollback in a tmux session that outlives the terminal. Nothing is lost by
 * hiding it, because the TUI never mints — its token is always one the user
 * passed on the command line, so they already know it. `shift+w` still opens the
 * unredacted URL; only the rendered string is trimmed.
 */
export function withoutToken(url: string): string {
  return url.replace(/\/?#k=[^#]*$/, "");
}

export function webUrl(host: string, port: number, token?: string): string {
  const base = `http://${bracket(host)}:${port}`;
  return token ? `${base}/#k=${encodeURIComponent(token)}` : base;
}
