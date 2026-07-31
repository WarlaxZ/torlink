// Whether the debrid provider will hand the browser an HLS manifest for a file.
//
// This is rung 2 of the player's source ladder: a container the browser cannot
// demux, played without this machine transcoding a byte or carrying one.
//
// Every "no" is the same null, because the caller's next move is identical for
// all of them — fall to the next rung. Nothing here throws.
import { getDebridProvider } from "../integrations/debrid";
import { loadConfig, resolveDebridTokenFor } from "../config/config";
import type { DebridProvider, DebridProviderId } from "../integrations/debrid/types";
import type { StreamSession } from "../core/streamSession";

export interface ResolveHlsDeps {
  /** That provider's token, or null when none is configured for it. */
  tokenImpl?: (provider: DebridProviderId) => Promise<string | null>;
  /** Injected in tests; `getDebridProvider` in production. */
  providerImpl?: (provider: DebridProviderId) => DebridProvider;
}

/**
 * Read the token for one provider, fresh.
 *
 * `loadConfig()` per call rather than a snapshot held at startup. `serve --web`
 * is a separate process from any running TUI, so a token changed in the terminal
 * would otherwise never be seen here — and the failure would look like the
 * provider rejecting a key the user had just fixed.
 */
async function tokenFromConfig(provider: DebridProviderId): Promise<string | null> {
  const config = await loadConfig();
  return resolveDebridTokenFor(config, provider) || null;
}

export function makeResolveHls(
  deps: ResolveHlsDeps = {},
): (session: StreamSession, index: number) => Promise<string | null> {
  return async (session, index) => {
    // Only a debrid-backed session has a provider to ask. A WebTorrent session
    // is rung 3's problem.
    if (session.backend !== "debrid" || !session.provider) return null;

    const file = session.files[index];
    if (!file?.providerFileId) return null;
    // An explicit false means the provider has told us it cannot transcode this.
    // Asking anyway returns manifest URLs that 404 when fetched, which the
    // browser would show as a load failure rather than the honest card.
    // `undefined` is not a no — it means the provider did not say.
    if (file.providerStreamable === false) return null;

    const providerId = session.provider;
    const provider = deps.providerImpl
      ? deps.providerImpl(providerId)
      : getDebridProvider(providerId);
    // Absence of the method IS the capability flag. Same pattern as checkCached.
    if (!provider.transcodeManifest) return null;

    try {
      // The SESSION's provider, not whichever is active now: a user can switch
      // providers while a session is live, and sending one service's key to
      // another is both a failure and a credential in the wrong place.
      const token = await (deps.tokenImpl ?? tokenFromConfig)(providerId);
      if (!token) return null;
      return await provider.transcodeManifest(token, file.providerFileId);
    } catch {
      return null;
    }
  };
}
