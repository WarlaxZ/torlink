import type { DebridProvider, DebridProviderId } from "./types";
import { realDebridProvider } from "./realdebrid";
import { torBoxProvider } from "./torbox";

/**
 * Every provider torlink can resolve through, in the order the accounts pane
 * lists them. Deliberately a runtime list and not `keyof`: the accounts pane
 * and the sources capability flag both iterate it.
 */
export const DEBRID_PROVIDER_IDS = ["realdebrid", "torbox"] as const satisfies readonly DebridProviderId[];

const PROVIDERS: Record<DebridProviderId, DebridProvider> = {
  realdebrid: realDebridProvider,
  torbox: torBoxProvider,
};

export function getDebridProvider(id: DebridProviderId): DebridProvider {
  return PROVIDERS[id];
}

export type { DebridProvider, DebridProviderId, DebridStatus, RequestOptions, ResolveOptions } from "./types";
