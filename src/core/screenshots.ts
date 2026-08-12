import { fetchResilient, type FetchImpl } from "../util/net";
import {
  extractTpbLandings,
  directFromLandingHtml,
  extract1337xImages,
  thumbFor,
  screenshotHostAllowed,
  type Shot,
} from "../util/screenshotExtract";

const TPB_API = "https://apibay.org";
// The same failover list 1337x search uses; a ref is a detail path, resolved
// against whichever host answers.
const X1337_HOSTS = ["1337x.to", "1337x.st", "x1337x.ws", "1337xx.to"];

interface Opts {
  fetchImpl?: FetchImpl;
  limit: number;
}

// A GET returning the body text, or null on any failure. `fetchResilient`
// defaults fetchImpl to torlinkFetch (the custom-DNS dispatcher) when none given.
async function text(url: string, fetchImpl?: FetchImpl): Promise<string | null> {
  try {
    const res = await fetchResilient(url, { retries: 0, fetchImpl });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function tpbShots(id: string, o: Opts): Promise<Shot[]> {
  const body = await text(`${TPB_API}/t.php?id=${encodeURIComponent(id)}`, o.fetchImpl);
  if (!body) return [];
  let descr = "";
  try {
    descr = (JSON.parse(body) as { descr?: string }).descr ?? "";
  } catch {
    return [];
  }
  const landings = extractTpbLandings(descr).slice(0, o.limit);
  const shots: Shot[] = [];
  for (const landing of landings) {
    const html = await text(landing, o.fetchImpl);
    const full = html ? directFromLandingHtml(html) : null;
    if (full && screenshotHostAllowed(full)) shots.push({ full, thumb: thumbFor(full) });
  }
  return shots;
}

async function x1337Shots(pathRef: string, o: Opts): Promise<Shot[]> {
  for (const host of X1337_HOSTS) {
    const html = await text(`https://${host}${pathRef}`, o.fetchImpl);
    if (!html) continue;
    const fulls = extract1337xImages(html).slice(0, o.limit);
    if (fulls.length) return fulls.map((full) => ({ full, thumb: thumbFor(full) }));
  }
  return [];
}

/**
 * Direct screenshot URLs for a torrent, resolved from its description. Lazy —
 * called on highlight, cached by the caller. `ref` is the apibay id for TPB, the
 * detail path for 1337x. Fails soft to []. Every fetch is allowlist-gated inside
 * the extract/resolve helpers.
 */
export async function screenshotsFor(source: string, ref: string, opts: Opts): Promise<Shot[]> {
  if (!ref) return [];
  const label = source.toLowerCase();
  if (label.includes("tpb") || label.includes("pirate")) return tpbShots(ref, opts);
  if (label.includes("1337")) return x1337Shots(ref, opts);
  return [];
}
