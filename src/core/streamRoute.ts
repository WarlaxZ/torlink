import { type Config, resolveActiveDebrid } from "../config/config";
import { getDebridProvider } from "../integrations/debrid";
import type { DebridProviderId, DebridStatus } from "../integrations/debrid/types";

export type StreamRoute =
  | { kind: "debrid"; provider: DebridProviderId }
  | { kind: "torrent-auto" }
  | { kind: "torrent-confirm"; reason: string };

// Decide how `v` should stream, given debrid config + last-known account status.
// "Not configured" (no token) auto-routes to torrent; a present-but-inactive
// account is "configured but not working" and requires an explicit confirm so we
// never silently expose the user's IP after they set a provider up.
export function classifyStreamRoute(config: Config, status: DebridStatus | null): StreamRoute {
  const active = resolveActiveDebrid(config);
  if (!active) return { kind: "torrent-auto" };
  // A status from a different provider is stale (the user switched); it says
  // nothing about the active account, so it must not refuse the stream.
  if (status && status.provider === active.provider && !status.active) {
    return {
      kind: "torrent-confirm",
      reason: `your ${getDebridProvider(active.provider).label} plan isn't active`,
    };
  }
  return { kind: "debrid", provider: active.provider };
}
