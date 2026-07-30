import type { DebridProvider, DebridProviderId } from "./types";
import { realDebridProvider } from "./realdebrid";

/**
 * Every provider torlink can resolve through, in the order the accounts pane
 * lists them. Deliberately a runtime list and not `keyof`: the accounts pane
 * and the sources capability flag both iterate it.
 */
export const DEBRID_PROVIDER_IDS = ["realdebrid"] as const satisfies readonly DebridProviderId[];

const PROVIDERS: Partial<Record<DebridProviderId, DebridProvider>> = {
  realdebrid: realDebridProvider,
};

export function getDebridProvider(id: DebridProviderId): DebridProvider {
  const provider = PROVIDERS[id];
  // Reachable only from a hand-edited config naming a provider this build does
  // not carry; resolveActiveDebrid validates the id, so this is a type guard.
  if (!provider) throw new Error(`Unknown debrid provider: ${id}`);
  return provider;
}

export type { DebridProvider, DebridProviderId, DebridStatus, RequestOptions, ResolveOptions } from "./types";
