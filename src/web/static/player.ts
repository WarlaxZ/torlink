// DOM binding for the player page. Every decision it makes lives in
// playerModel.ts, which is pure and unit-tested; this file is wiring only, and
// is kept boring on purpose so that reading it is enough to know what reaches
// the page.
//
// Bundled for the browser: nothing from node:*. Types from `../wire.ts` are
// fair game (they are erased at build time) and so is `src/util/`, the layer
// both front ends share — `npm run build` is what proves any such import is
// browser-safe, following transitive imports where a grep cannot.
//
// SAME HARD RULE AS app.ts: every node here is built with createElement and
// filled with textContent. The filename comes out of a torrent — i.e. from
// whoever made it — and there is no innerHTML, insertAdjacentHTML or
// document.write in this file, and there must never be one.
import {
  PLAYBACK_STALL_MS,
  STALL_MS,
  absoluteUrl,
  chooseSource,
  detectPlatform,
  fallbackMessage,
  infoPath,
  interruptedNotice,
  parsePlayerLocation,
  playlistPath,
  routeFailure,
  streamPath,
  vlcLinks,
  type FallbackReason,
  type PlayerTarget,
} from "./playerModel";
import { mountHls } from "./hlsMount";
import type { StreamInfoResponse } from "../wire";

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const nameLabel = el<HTMLParagraphElement>("file-name");
const stage = el<HTMLDivElement>("stage");
const actions = el<HTMLDivElement>("actions");
const notice = el<HTMLParagraphElement>("notice");
const NOTICE_MS = 4000;

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * `persist` for a notice the user must still be able to read after they look
 * back at the screen. The copy-button notices are acknowledgements of something
 * the user just did and self-clear; a stream that died mid-playback is not, and
 * a four-second explanation of a video that is going to stay frozen is worse
 * than none — they would be left with the silence this notice exists to break.
 */
function showNotice(message: string, opts: { persist?: boolean } = {}): void {
  notice.textContent = message;
  notice.hidden = false;
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = null;
  if (opts.persist === true) return;
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    notice.hidden = true;
  }, NOTICE_MS);
}

function hideNotice(): void {
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = null;
  notice.hidden = true;
  notice.textContent = "";
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function linkButton(label: string, href: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "button-link";
  a.textContent = label;
  // `href` is a property assignment, not markup, and every value that reaches
  // it was built by playerModel.ts from an encoded origin and capability.
  a.href = href;
  return a;
}

/**
 * Replace the player with an honest explanation.
 *
 * Called for a container the browser cannot demux (before any element is
 * created), for a decode error, and for a stall. Deliberately destructive: the
 * `<video>` is removed rather than hidden, so nothing keeps buffering a file
 * that is not going to play and no black rectangle is left behind it.
 */
function showFallback(reason: FallbackReason, filename: string): void {
  const card = document.createElement("div");
  card.className = "card fallback";

  const title = document.createElement("h2");
  title.textContent = "This one needs a real player";

  const body = document.createElement("p");
  body.className = "fallback-body";
  body.textContent = fallbackMessage(reason, filename);

  card.append(title, body);
  stage.replaceChildren(card);
}

function createVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  video.className = "player";
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  // "metadata", not "auto": the browser should discover the duration and the
  // first frame — which is exactly what tells us whether it can play this at
  // all — without pulling the whole file through the proxy behind it.
  video.preload = "metadata";
  return video;
}

/**
 * Watch a `<video>` for the failure that produces no event.
 *
 * Shared by every rung that mounts an element, because an HLS mount needs
 * exactly the same "no frame, no error, twelve seconds" detection as a direct
 * `src` does — and two copies of it would drift.
 *
 * The silent failure is the one that matters. A container the browser hates
 * often produces no `error` event at all: the element simply never reaches
 * `loadeddata`. So the timer is the primary detector and the event is the fast
 * path, and the first of them to fire wins.
 */
function watch(video: HTMLVideoElement, target: PlayerTarget): { report: (r: FallbackReason) => void } {
  // THREE states, not one flag. Collapsing them into a single `settled` latch is
  // the bug this shape replaces: the latch was set by the first `playing` event
  // and then swallowed every subsequent failure, so a stream that died partway
  // through left a frozen <video> and told the user nothing at all.
  //
  // - `started`: a frame arrived, so the start-up stall timer is wrong now.
  // - `replaced`: a card has taken the element's place; there is nothing to
  //   annotate and nothing to fail a second time.
  // - `notified`: a mid-playback failure is already on screen, so a burst of
  //   error events produces one notice rather than a flicker of them.
  let started = false;
  let replaced = false;
  let notified = false;

  const fail = (reason: FallbackReason): void => {
    if (replaced) return;
    replaced = true;
    clearTimeout(timer);
    clearTimeout(stallTimer);
    // Removing the src and calling load() is what actually stops an in-flight
    // fetch; dropping the element alone leaves the request running in some
    // browsers, and behind it a range request against a live torrent.
    video.removeAttribute("src");
    video.load();
    showFallback(reason, target.filename);
  };

  /**
   * Report one failure, to whichever half of the player's life it belongs to.
   *
   * `routeFailure` makes the choice and is unit-tested; this is the wiring for
   * its two answers. The notice branch deliberately leaves the element alone:
   * the user has already watched some of this, and destroying it would throw
   * away their position to tell them something untrue about what they saw.
   */
  const report = (reason: FallbackReason): void => {
    if (routeFailure(started) === "card") {
      fail(reason);
      return;
    }
    if (replaced || notified) return;
    notified = true;
    showNotice(interruptedNotice(reason), { persist: true });
  };

  const ok = (): void => {
    if (replaced) return;
    started = true;
    clearTimeout(timer);
  };

  // The start-up watchdog: no frame at all, ever. Disarmed by `ok`.
  const timer = setTimeout(() => report("stall"), STALL_MS);

  // The other watchdog, and the one this file previously had no answer for: a
  // player that ran and then stopped advancing. `waiting` is the browser saying
  // it has run out of buffered media, which is exactly the shape of a provider
  // transcode that stops producing segments — and on that path hls.js may report
  // nothing fatal, so without this timer there is no event to react to at all.
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStall = (): void => {
    if (replaced || !started) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => report("stall"), PLAYBACK_STALL_MS);
  };
  // Progress is the all-clear. If a gap filled itself after we spoke, the notice
  // is now false, so it goes — and `notified` resets, because the next stall is
  // news again.
  const progressing = (): void => {
    clearTimeout(stallTimer);
    stallTimer = undefined;
    if (notified) {
      notified = false;
      hideNotice();
    }
  };

  video.addEventListener("error", () => report("error"));
  video.addEventListener("loadeddata", ok);
  video.addEventListener("playing", ok);
  video.addEventListener("waiting", armStall);
  video.addEventListener("stalled", armStall);
  video.addEventListener("timeupdate", progressing);
  video.addEventListener("playing", progressing);
  // A file that reaches its end has not stalled, and must not be accused of it.
  video.addEventListener("ended", () => {
    clearTimeout(stallTimer);
    stallTimer = undefined;
  });
  return { report };
}

// autoplay is blocked without a user gesture in every browser that matters; the
// rejection is expected and is not a playback failure, so it must never reach
// `fail`. The controls are right there.
function tryPlay(video: HTMLVideoElement): void {
  void video.play().catch(() => {});
}

function mountVideo(target: PlayerTarget, src: string): void {
  const video = createVideo();
  video.src = src;
  watch(video, target);
  stage.replaceChildren(video);
  tryPlay(video);
}

async function render(): Promise<void> {
  const target = parsePlayerLocation(location.pathname, location.search);
  if (!target || !target.capability) {
    nameLabel.textContent = "";
    showFallback("no-link", "");
    return;
  }

  nameLabel.textContent = target.filename || "Unnamed file";
  nameLabel.title = target.filename;
  document.title = target.filename ? `${target.filename} — torlnk` : "torlnk";

  const stream = absoluteUrl(location.origin, streamPath(target));
  const playlist = absoluteUrl(location.origin, playlistPath(target));

  const controls: (HTMLButtonElement | HTMLAnchorElement)[] = [
    linkButton("Download .m3u", playlist),
    button("Copy stream URL", () => {
      // clipboard.writeText is unavailable on insecure origins — which is the
      // normal way this dashboard is reached over a LAN — and rejects when the
      // page is not focused. Both are reported rather than swallowed, because a
      // copy button that silently does nothing is worse than no button.
      const clip = navigator.clipboard;
      if (!clip) {
        showNotice("Copying needs a secure context — download the .m3u instead.");
        return;
      }
      void clip.writeText(stream).then(
        () => showNotice("Stream URL copied."),
        () => showNotice("Couldn't copy — download the .m3u instead."),
      );
    }),
  ];
  for (const link of vlcLinks(stream, detectPlatform(navigator.userAgent))) {
    controls.push(linkButton(link.label, link.href));
  }
  actions.replaceChildren(...controls);

  // Ask the server what this file actually is before creating any element. This
  // is what removes the twelve-second black rectangle: a container or codec the
  // browser refuses is now known up front rather than discovered by a decode
  // error that, for mkv in Chrome, never even fires.
  const info = await fetchInfo(target);
  const chosen = chooseSource(info, target.filename);
  if (chosen.rung === "card") {
    showFallback(chosen.reason ?? "container", target.filename);
    return;
  }
  if (chosen.rung === "provider-hls" && info?.hls) {
    const video = createVideo();
    const settle = watch(video, target);
    stage.replaceChildren(video);
    // The manifest is on the provider's own host, so no capability is appended:
    // it is already a capability, being an unguessable URL minted for this file.
    await mountHls(video, info.hls, { onError: () => settle.report("error") });
    tryPlay(video);
    return;
  }
  mountVideo(target, stream);
}

/**
 * Fetch `.info`, or null.
 *
 * Null on any failure — offline, a 401, a server old enough not to have the
 * route. `chooseSource` treats null as "decide from the filename", which is
 * what this page did before the route existed, so a failure here degrades to
 * the previous behaviour rather than to a blank page.
 */
async function fetchInfo(target: PlayerTarget): Promise<StreamInfoResponse | null> {
  try {
    const res = await fetch(absoluteUrl(location.origin, infoPath(target)));
    if (!res.ok) return null;
    return (await res.json()) as StreamInfoResponse;
  } catch {
    return null;
  }
}

void render();
