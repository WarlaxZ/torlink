import { type Config, resolveRealDebridToken } from "../config/config";
import type { RdStatus } from "../integrations/rdStatus";

export type StreamRoute =
  | { kind: "realdebrid" }
  | { kind: "torrent-auto" }
  | { kind: "torrent-confirm"; reason: string };

// Decide how `v` should stream, given RD config + last-known account status.
// "Not configured" (no token) auto-routes to torrent; a present-but-non-premium
// token is "configured but not working" and requires an explicit confirm so we
// never silently expose the user's IP after they set RD up.
export function classifyStreamRoute(config: Config, rdStatus: RdStatus | null): StreamRoute {
  if (!resolveRealDebridToken(config)) return { kind: "torrent-auto" };
  if (rdStatus && !rdStatus.premium) {
    return { kind: "torrent-confirm", reason: "your Real-Debrid premium isn't active" };
  }
  return { kind: "realdebrid" };
}
