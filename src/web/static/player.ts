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
  filesPath,
  infoPath,
  interruptedNotice,
  parsePlayerLocation,
  playlistPath,
  primaryAction,
  restPlaylistPath,
  routeFailure,
  streamPath,
  vlcLinks,
  type FallbackReason,
  type PlayerTarget,
} from "./playerModel";
import { clipboardPorts, copyNotice, copyText } from "./copyText";
import type { MediaFacts } from "../../util/playability";
import { mountHls } from "./hlsMount";
import { breadcrumbFor, escapeRoutes, upNextView, type EpisodeRow } from "./upNext";
import { authHeadersFor, readStoredToken } from "./token";
import { backTarget, readReturn } from "./returnTo";
import type { LibraryRequest, StreamFilesResponse, StreamInfoResponse } from "../wire";

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const backLink = el<HTMLAnchorElement>("back");
const breadcrumb = el<HTMLParagraphElement>("breadcrumb");
const nameLabel = el<HTMLParagraphElement>("file-name");
const stage = el<HTMLDivElement>("stage");
const actions = el<HTMLDivElement>("actions");
const notice = el<HTMLParagraphElement>("notice");
const episodes = el<HTMLDivElement>("episodes");
const NOTICE_MS = 4000;

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * `persist` for a notice the user must still be able to read after they look
 * back at the screen. Most copy-button notices are acknowledgements of
 * something the user just did and self-clear — the exception is the one that
 * asks the user to copy the revealed field by hand, which is an instruction
 * rather than an acknowledgement and outlives its four seconds. A stream that
 * died mid-playback is not an acknowledgement either, and
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

/**
 * The last resort when the browser refuses to copy on the page's behalf: the
 * URL, in a field, already selected, so ⌘C or Ctrl+C finishes the job.
 *
 * It lives inside `actions` so that the per-target `replaceChildren` clears it;
 * a stale URL left under a different file would be worse than no field at all.
 */
let manualField: HTMLInputElement | null = null;

function revealManualCopy(url: string): void {
  if (manualField === null) {
    manualField = document.createElement("input");
    manualField.type = "text";
    manualField.className = "manual-copy";
    manualField.readOnly = true;
    manualField.setAttribute("aria-label", "Stream URL");
    actions.append(manualField);
  }
  // A property assignment, not markup.
  manualField.value = url;
  manualField.focus();
  manualField.select();
  // iOS ignores select() on a readonly field by itself.
  manualField.setSelectionRange(0, url.length);
}

function clearManualCopy(): void {
  manualField?.remove();
  manualField = null;
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
function showFallback(reason: FallbackReason, filename: string, facts?: MediaFacts): void {
  const card = document.createElement("div");
  card.className = "card fallback";

  const title = document.createElement("h2");
  title.textContent = "This one needs a real player";

  const body = document.createElement("p");
  body.className = "fallback-body";
  // `facts` is what the server actually probed. Passing it turns "most releases
  // are MKV with HEVC or DTS audio" into the codec this file really carries,
  // which is the difference between a message you can act on and one you can
  // only accept.
  body.textContent = fallbackMessage(reason, filename, facts);

  card.append(title, body);

  // TWO WAYS OUT, because this card is the end of the most common journey
  // through the app and it used to be a cul-de-sac that blamed the browser.
  // Both are ordinary links to the dashboard, so they work on a phone that
  // holds this session's capability and no bearer token.
  const outs = escapeRoutes(filename);
  if (outs.length > 0) {
    const nav = document.createElement("p");
    nav.className = "fallback-outs";
    for (const out of outs) {
      const a = document.createElement("a");
      a.textContent = out.label;
      a.href = out.href;
      nav.append(a);
    }
    card.append(nav);
  }

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

  // From the URL, before any fetch — so there is a way back even if every
  // request below fails. Upgraded to the session's release name if `.files`
  // lands. Skipped for an unnamed link, where there is nothing to parse.
  if (target.filename) renderBreadcrumb(target.filename);

  const stream = absoluteUrl(location.origin, streamPath(target));
  const playlist = absoluteUrl(location.origin, playlistPath(target));

  const platform = detectPlatform(navigator.userAgent);
  const m3u = linkButton("Download .m3u", playlist);
  const vlc = vlcLinks(stream, platform).map((link) => linkButton(link.label, link.href));

  // Ordered by what actually works here, not by a fixed list. `primaryAction`
  // carries the reasoning; the effect is that a phone leads with Open in VLC
  // rather than with a download its OS will not hand to a player, and the lead
  // control is the only highlighted one so there is a first thing to press.
  const lead = primaryAction(platform) === "vlc" && vlc.length > 0 ? vlc : [m3u];
  const rest = lead === vlc ? [m3u] : vlc;
  lead[0]?.classList.add("primary");

  const controls: (HTMLButtonElement | HTMLAnchorElement)[] = [
    ...lead,
    button("Copy stream URL", () => {
      // copyText must be called straight from the click with nothing awaited in
      // front of it: on an insecure origin — the normal way this dashboard is
      // reached over a LAN — it copies via execCommand, which the browser only
      // permits inside the task the gesture started.
      const outcome = copyText(stream, clipboardPorts());
      void Promise.resolve(outcome).then((result) => {
        // Persisted for "manual" alone: that notice is an instruction attached
        // to a field that stays on screen, so letting it self-clear would leave
        // an unlabelled selected URL box and no reason for it.
        showNotice(copyNotice(result), { persist: result === "manual" });
        if (result === "manual") revealManualCopy(stream);
        else clearManualCopy();
      });
    }),
    ...rest,
  ];
  // The vlcLinks append that used to sit here is gone, not lost: `lead` and
  // `rest` above already place those buttons, and by platform rather than
  // always last. Appending them again would render VLC twice.
  //
  // replaceChildren drops any field left over from the previous target, so the
  // reference has to go with it.
  manualField = null;
  actions.replaceChildren(...controls);

  // The rest of the torrent, and the bookkeeping — BEFORE the playability
  // question below, and never gated on its answer. The whole reported failure
  // is the flow where the browser CANNOT play the file: the user downloads the
  // .m3u, watches it in VLC, comes back, and wants the next episode. Putting
  // this after an early `return` would remove it from exactly that case.
  //
  // Not awaited: `.files` is a small JSON read and the playability probe behind
  // `.info` can take seconds, so they run together and whichever lands first
  // paints. Nothing below depends on this.
  void fetchFiles(target).then((body) => {
    if (!body) return; // offline, a 401, an older server — the page still plays
    recordPlayed(body, target);
    renderEpisodes(body, target);
  });

  // Ask the server what this file actually is before creating any element. This
  // is what removes the twelve-second black rectangle: a container or codec the
  // browser refuses is now known up front rather than discovered by a decode
  // error that, for mkv in Chrome, never even fires.
  const info = await fetchInfo(target);
  const chosen = chooseSource(info, target.filename);
  if (chosen.rung === "card") {
    showFallback(chosen.reason ?? "container", target.filename, info?.facts);
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

/** Fetch `.files`, or null. Null on any failure, for the reason `fetchInfo` is. */
async function fetchFiles(target: PlayerTarget): Promise<StreamFilesResponse | null> {
  try {
    const res = await fetch(absoluteUrl(location.origin, filesPath(target)));
    if (!res.ok) return null;
    return (await res.json()) as StreamFilesResponse;
  } catch {
    return null;
  }
}

/**
 * Tell the server this file was opened, so Continue-watching keeps advancing.
 *
 * THE SAME CALL THE PICKER MAKES, deliberately. `app.ts` fires this before
 * navigating here, which was the only writer while the picker was the only way
 * to reach a player page. Jumping episode to episode from the list below never
 * touches the picker, so without this the high-water mark would freeze at
 * whichever episode you happened to pick — and the saved pane would keep
 * offering an episode you watched an hour ago.
 *
 * One mechanism, two call sites, one route. `recordPlayedFile`
 * (`src/core/streamHistory.ts`) is a high-water mark that returns the same array
 * reference when nothing moved, so recording twice costs nothing and the
 * picker's call stays as the fallback for when this one cannot be made.
 *
 * BEST-EFFORT, and silent. `/api/library` needs the bearer token, which this
 * page reads from sessionStorage: `openPlayer` navigates the same tab, so it is
 * simply there for the ordinary flow. A cold-opened player URL — a bookmark, a
 * link handed to a phone — has no token and does not record, which is the right
 * answer for someone else's link anyway. Nothing here is worth interrupting
 * playback to report.
 */
function recordPlayed(body: StreamFilesResponse, target: PlayerTarget): void {
  const filename = body.files.find((f) => f.index === target.index)?.filename;
  if (!filename) return;
  const request: LibraryRequest = {
    infoHash: body.infoHash,
    name: body.name,
    action: "watched",
    filename,
  };
  void fetch("/api/library", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeadersFor(readStoredToken()) },
    body: JSON.stringify(request),
  }).catch(() => {});
}

/** One heading in the episode list. A `<p>`, not an `<h*>`: it labels a run of rows. */
function listHeading(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "episodes-heading";
  p.textContent = text;
  return p;
}

/**
 * One row: a link to the same page for a different file.
 *
 * `textContent`, as everywhere on this page — a filename comes out of a torrent,
 * i.e. from whoever uploaded it. The `href` is a property assignment built by
 * `playerPath`, not markup.
 */
function episodeRow(row: EpisodeRow): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = row.current ? "episode-row is-current" : "episode-row";
  a.href = row.href;
  a.textContent = row.label;
  a.title = row.file.filename;
  if (row.current) {
    // The page you are already on. Announced rather than merely styled, so the
    // list reads the same to a screen reader as it looks.
    a.setAttribute("aria-current", "true");
  }
  return a;
}

/**
 * The rest of the torrent, under the player.
 *
 * Hidden entirely for a single-file session, so a film looks exactly as it did
 * before this existed.
 */
/**
 * The way back to the show.
 *
 * Rendered from whatever name is available, and rendered EARLY. The first call
 * uses `?n=`, the filename in the page's own URL, so the breadcrumb is on screen
 * before any request has been made — and, crucially, still on screen when
 * `.files` fails. That is the case where it matters most: a session the registry
 * has reaped leaves a page that can neither play nor list anything, and the
 * breadcrumb is then the only way out that does not involve the address bar. An
 * earlier version rendered it inside `renderEpisodes`, which meant it vanished
 * in exactly that situation.
 *
 * The second call, once `.files` lands, upgrades it to the session's release
 * name — "Harrowgate.S03.1080p.WEB-DL" names the show more reliably than one
 * episode's filename does, and for a file inside a folder it may be the only
 * thing that names it at all.
 */
function renderBreadcrumb(name: string): void {
  const crumb = breadcrumbFor(name);
  breadcrumb.replaceChildren(link(crumb.label, crumb.href));
  breadcrumb.hidden = false;
}

function renderEpisodes(body: StreamFilesResponse, target: PlayerTarget): void {
  const view = upNextView(body, target.sid, target.index, target.capability);

  renderBreadcrumb(body.name);

  if (view.rows.length === 0) {
    episodes.replaceChildren();
    episodes.hidden = true;
    return;
  }

  const nodes: HTMLElement[] = [];
  // "Up next" sits ABOVE the full list on purpose: it is the one action this
  // page exists to offer, and it must not depend on scrolling past sixty rows.
  if (view.next) nodes.push(listHeading("up next"), episodeRow(view.next));
  // Appended rather than built with the other controls because it depends on
  // `.files`, which lands after the first paint. WHETHER to show it and WHAT to
  // call it are `upNextView`'s answers, not this file's — it used to hang off
  // "is there a next row", which offered "rest of season" from a bonus feature.
  if (view.restLabel !== null) {
    actions.append(
      linkButton(view.restLabel, absoluteUrl(location.origin, restPlaylistPath(target))),
    );
  }
  nodes.push(listHeading(view.next ? "all episodes" : "everything in this torrent"));
  for (const row of view.rows) {
    if (row.heading) nodes.push(listHeading(row.heading));
    nodes.push(episodeRow(row));
  }
  episodes.replaceChildren(...nodes);
  episodes.hidden = false;
}

/** A plain anchor. Same rule as everything else here: textContent, href as a property. */
function link(text: string, href: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.textContent = text;
  a.href = href;
  return a;
}

/**
 * Back means "the page I came from", when this tab knows where that was.
 *
 * `backTarget` (returnTo.ts) decides; this is the two DOM effects of its two
 * answers. Note what it is NOT keyed on: `document.referrer` is always empty
 * here, because `player.html` sets `no-referrer` so this page's `?k=` never
 * leaks into a Referer — a back link built on the referrer would silently never
 * fire, which is exactly what happened on the first attempt.
 *
 * The href is also rewritten up front rather than only on click, so that
 * middle-click, "open in new tab" and the status bar all agree with what a
 * plain click does.
 */
const back = backTarget(readReturn(), history.length, backLink.getAttribute("href") ?? "/");
if (back.kind === "href") {
  backLink.href = back.href;
} else {
  backLink.addEventListener("click", (event) => {
    event.preventDefault();
    history.back();
  });
}

void render();
