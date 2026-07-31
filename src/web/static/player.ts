// DOM binding for the player page. Every decision it makes lives in
// playerModel.ts, which is pure and unit-tested; this file is wiring only, and
// is kept boring on purpose so that reading it is enough to know what reaches
// the page.
//
// Bundled for the browser: nothing from node:*, nothing from the repo outside
// this directory.
//
// SAME HARD RULE AS app.ts: every node here is built with createElement and
// filled with textContent. The filename comes out of a torrent — i.e. from
// whoever made it — and there is no innerHTML, insertAdjacentHTML or
// document.write in this file, and there must never be one.
import {
  STALL_MS,
  absoluteUrl,
  chooseSource,
  detectPlatform,
  fallbackMessage,
  infoPath,
  parsePlayerLocation,
  playlistPath,
  streamPath,
  vlcLinks,
  type FallbackReason,
  type PlayerTarget,
} from "./playerModel";
import type { StreamInfoResponse } from "../wire";

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const nameLabel = el<HTMLParagraphElement>("file-name");
const stage = el<HTMLDivElement>("stage");
const actions = el<HTMLDivElement>("actions");
const notice = el<HTMLParagraphElement>("notice");
const NOTICE_MS = 4000;

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function showNotice(message: string): void {
  notice.textContent = message;
  notice.hidden = false;
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    notice.hidden = true;
  }, NOTICE_MS);
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

function mountVideo(target: PlayerTarget, src: string): void {
  const video = document.createElement("video");
  video.className = "player";
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  // "metadata", not "auto": the browser should discover the duration and the
  // first frame — which is exactly what tells us whether it can play this at
  // all — without pulling the whole file through the proxy behind it.
  video.preload = "metadata";
  video.src = src;

  // The silent failure is the one that matters. A container the browser hates
  // often produces no `error` event at all: the element simply never reaches
  // `loadeddata`. So the timer is the primary detector and the event is the
  // fast path, and the first of them to fire wins.
  let settled = false;
  const fail = (reason: FallbackReason): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Removing the src and calling load() is what actually stops an in-flight
    // fetch; dropping the element alone leaves the request running in some
    // browsers, and behind it a range request against a live torrent.
    video.removeAttribute("src");
    video.load();
    showFallback(reason, target.filename);
  };
  const ok = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
  };

  const timer = setTimeout(() => fail("stall"), STALL_MS);
  video.addEventListener("error", () => fail("error"));
  video.addEventListener("loadeddata", ok);
  video.addEventListener("playing", ok);

  stage.replaceChildren(video);
  // autoplay is blocked without a user gesture in every browser that matters;
  // the rejection is expected and is not a playback failure, so it must not
  // reach `fail`. The controls are right there.
  void video.play().catch(() => {});
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
  if (chosen.rung === "provider-hls") {
    // Task 9 replaces this with mountHls. Until then `resolveHls` is left unset
    // in the server's StreamDeps, so `info.hls` is always null in production and
    // this branch is unreachable — see the note in server.ts. It is written out
    // rather than left to fall through because a branch that silently renders
    // nothing is the failure mode this file is built to avoid.
    showFallback("container", target.filename);
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
