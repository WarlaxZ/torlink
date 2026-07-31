// Attaching an HLS manifest to a <video>, by whichever route this browser has.
//
// `hlsStrategy` is the decision and is unit-tested. `mountHls` is wiring: it
// loads a library and touches the DOM, neither of which a test in this repo can
// reach, so it is kept to the minimum that reading it end to end is enough.
const HLS_MIME = "application/vnd.apple.mpegurl";

export type HlsStrategy = "native" | "mse" | "unsupported";

/**
 * Media Source Extensions first; native HLS only where there is no MSE.
 *
 * The order looks backwards and is not. **`canPlayType` cannot be trusted for
 * HLS**: Chrome on macOS answers `"maybe"` for `application/vnd.apple.mpegurl`
 * and then plays nothing at all — no error event either, so the page sat on a
 * black rectangle until the stall timer fired. That was measured, not guessed;
 * an earlier version of this function preferred native and broke every desktop
 * browser exactly that way.
 *
 * MSE, by contrast, is a real capability: if it is there, hls.js works. So MSE
 * decides first, and `canPlayType` is consulted only when hls.js has no engine
 * to run on — which is the iPhone Safari case, where there is no MSE and native
 * HLS genuinely does work. Since a phone is the device this page mostly exists
 * for, that branch matters as much as the other.
 *
 * `canPlayType` returns "", "maybe" or "probably"; only "" is a no.
 */
export function hlsStrategy(
  canPlayHls: (type: string) => string,
  hasMediaSource: boolean,
): HlsStrategy {
  if (hasMediaSource) return "mse";
  return canPlayHls(HLS_MIME) !== "" ? "native" : "unsupported";
}

/** Whether this browser can run hls.js at all. */
export function hasMse(): boolean {
  return typeof window !== "undefined" && "MediaSource" in window;
}

/**
 * Point a `<video>` at an HLS manifest.
 *
 * `hls.js` is imported dynamically so a direct-play mp4 never downloads it — it
 * is by far the largest thing in this bundle. `onError` is called for a fatal
 * error only: hls.js recovers from plenty of non-fatal ones by itself, and
 * reporting those would replace a video that is about to play with a card.
 */
export async function mountHls(
  video: HTMLVideoElement,
  manifest: string,
  hooks: { onError: () => void },
): Promise<void> {
  const strategy = hlsStrategy((t) => video.canPlayType(t), hasMse());
  if (strategy === "unsupported") {
    hooks.onError();
    return;
  }
  if (strategy === "native") {
    video.src = manifest;
    return;
  }
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) {
    hooks.onError();
    return;
  }
  const hls = new Hls();
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) {
      hls.destroy();
      hooks.onError();
    }
  });
  hls.loadSource(manifest);
  hls.attachMedia(video);
}
