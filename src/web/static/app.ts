// DOM binding for the dashboard. All the interesting state lives in
// dashboard.ts, which is pure and unit-tested; this file is only wiring, and it
// is deliberately kept boring so that reading it end to end is enough to know
// what reaches the page.
//
// Bundled for the browser, so it must import nothing from node:* and nothing in
// the repo outside this directory.
import {
  formatBytes,
  formatRate,
  mergeRows,
  rowsFromStatus,
  shortName,
  type DashRow,
  type StatusPayload,
} from "./dashboard";
import {
  fileLabel,
  isPlayable,
  nextSort,
  pickerRows,
  playerPath,
  runPlay,
  wantedEpisodeFor,
  type EpisodeRef,
  type StreamFileSort,
  type PublicStreamFile,
  type PublicStreamSession,
  type StartResult,
  type StartStreamResponse,
  type StreamConfirmResponse,
} from "./streamFlow";
import {
  addBody,
  addPlan,
  ALL_TAB,
  cachedTag,
  categoryTabs,
  dashRowForPlay,
  debridAddedNotice,
  debridAddLabel,
  emptyView,
  modeForQuery,
  parseLayout,
  parseSort,
  previewApplies,
  reportsHealthLookup,
  resultMeta,
  rowForPlay,
  searchStatus,
  searchUrl,
  sourceLabel,
  statusLineHidden,
  tabClickPlan,
  visibleResults,
  type AddVia,
  type PublicSearchResult,
  type PublicSearchSnapshot,
  type ResultLayout,
  type SearchView,
  type SourcesResponse,
} from "./searchModel";
import {
  createPreviewController,
  posterPath,
  previewCopy,
  type PreviewState,
  type PublicTitleMeta,
} from "./previewModel";
import {
  createPosterCache,
  postersApply,
  searchHint,
  type PosterOutcome,
} from "./resultPosters";
import {
  ACTION_LABEL,
  createReccController,
  dismissesPick,
  actionNotice,
  isRatingAction,
  pickSub,
  reasonLine,
  reasonTitle,
  reccEventBody,
  reccItems,
  reccPosterHint,
  reccPosterNote,
  reccStatus,
  recommendationsUrl,
  RECC_ACTIONS,
  saveSearchBlockedNotice,
  searchGroupForType,
  titleToSave,
  type PublicRecommendation,
  type PublicRecommendations,
  type ReccAction,
  type ReccPosterOutcome,
  type ReccState,
  type ReccType,
} from "./reccModel";
import {
  applyContinueWatchingResponse,
  applyLibraryResponse,
  applySaved,
  applySavedSearchesResponse,
  continueWatchingBody,
  continueWatchingFallbackQuery,
  continueWatchingStatus,
  continueWatchingSub,
  emptySaved,
  favouriteLabel,
  favouriteMeta,
  isInLibrary,
  libraryBody,
  libraryStatus,
  libraryToggleNotice,
  savedSearchesBody,
  savedSearchesStatus,
  savedSearchesToggleNotice,
  type LibraryInput,
  type PublicFavourite,
  type PublicStreamHistoryItem,
  type SavedState,
} from "./savedModel";
import { tokenFromHash } from "./authLink";
import {
  FEATURE_IDS,
  FEATURES,
  NEXT_FEATURE_STATE,
  FEATURE_STATE_MARK,
  pickSearchingLine,
  pickNoneLine,
  type FeatureState,
} from "../../util/releasePick";
import type { ReccMedium } from "../../util/autoPlayableFilm";
import {
  autoPlayableFilm,
  createPickController,
  intentForHistoryRow,
  prefsFromWire,
  type PickState,
} from "./pickModel";
import type { PreferencesResponse, PublicQualityPrefs } from "../wire";

// The token is held in sessionStorage and sent as an Authorization header on
// every API call. No cookie authenticates the API — but that does NOT mean there
// is no CSRF vector, which is what this comment used to claim: the usual way to
// run the dashboard is with no token at all, and then there is no credential to
// forge in the first place. A cross-origin page's POST would simply have been
// authorized. The server rejects state-changing requests whose Origin /
// Sec-Fetch-Site say cross-site (daemon/auth.ts, isCrossSiteRequest); this
// page's own fetches are same-origin and unaffected.
const TOKEN_KEY = "torlnk.token";

const EMPTY_TEXT = "Nothing in the queue.";
const NOTICE_MS = 4000;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const authForm = el<HTMLFormElement>("auth");
const authError = el<HTMLParagraphElement>("auth-error");
const tokenInput = el<HTMLInputElement>("token");
const app = el<HTMLElement>("app");
const addForm = el<HTMLFormElement>("add");
const magnetInput = el<HTMLInputElement>("magnet");
const rowsList = el<HTMLUListElement>("rows");
const emptyNote = el<HTMLParagraphElement>("empty");
const notice = el<HTMLParagraphElement>("notice");
const conn = el<HTMLSpanElement>("conn");
const picker = el<HTMLDivElement>("picker");
const pickerTitle = el<HTMLParagraphElement>("picker-title");
const pickerFiles = el<HTMLUListElement>("picker-files");
const pickerCancel = el<HTMLButtonElement>("picker-cancel");
const pickerSort = el<HTMLButtonElement>("picker-sort");

const prefsBlock = el<HTMLDetailsElement>("prefs");
const prefsResSelect = el<HTMLSelectElement>("pref-res");
const prefsFeaturesBox = el<HTMLDivElement>("pref-features");

const viewsNav = el<HTMLElement>("views");
const viewSearchTab = el<HTMLButtonElement>("view-search");
const viewReccTab = el<HTMLButtonElement>("view-recc");
const viewSavedTab = el<HTMLButtonElement>("view-saved");
const viewQueueTab = el<HTMLButtonElement>("view-queue");
const queueCount = el<HTMLSpanElement>("queue-count");
const paneSearch = el<HTMLElement>("pane-search");
const paneRecc = el<HTMLElement>("pane-recc");
const paneSaved = el<HTMLElement>("pane-saved");
const paneQueue = el<HTMLElement>("pane-queue");
const savedSearchesStatusLine = el<HTMLParagraphElement>("saved-searches-status");
const savedSearchesRows = el<HTMLUListElement>("saved-searches-rows");
const libraryStatusLine = el<HTMLParagraphElement>("library-status");
const libraryRows = el<HTMLUListElement>("library-rows");
const continueStatusLine = el<HTMLParagraphElement>("continue-status");
const continueRows = el<HTMLUListElement>("continue-rows");

const reccTypeSelect = el<HTMLSelectElement>("recc-type");
const reccGenreInput = el<HTMLInputElement>("recc-genre");
const reccExploreCheck = el<HTMLInputElement>("recc-explore");
const reccRefreshButton = el<HTMLButtonElement>("recc-refresh");
const reccStatusLine = el<HTMLParagraphElement>("recc-status");
const reccHintLine = el<HTMLParagraphElement>("recc-hint");
const reccList = el<HTMLUListElement>("recc-list");

const searchForm = el<HTMLFormElement>("search");
const queryInput = el<HTMLInputElement>("query");
const saveSearchButton = el<HTMLButtonElement>("save-search");
const tabsBar = el<HTMLDivElement>("tabs");
const sortSelect = el<HTMLSelectElement>("sort");
const filterInput = el<HTMLInputElement>("filter");
const aliveCheck = el<HTMLInputElement>("alive");
const layoutControl = el<HTMLLabelElement>("layout-control");
const layoutSelect = el<HTMLSelectElement>("layout");
const searchProgress = el<HTMLSpanElement>("search-progress");
const searchStatusLine = el<HTMLParagraphElement>("search-status");
const searchHintLine = el<HTMLParagraphElement>("search-hint");
const resultsList = el<HTMLUListElement>("results");

const previewPane = el<HTMLElement>("preview");
const previewPoster = el<HTMLDivElement>("preview-poster");
const previewTitle = el<HTMLParagraphElement>("preview-title");
const previewSub = el<HTMLParagraphElement>("preview-sub");
const previewBody = el<HTMLParagraphElement>("preview-body");
const previewImdb = el<HTMLAnchorElement>("preview-imdb");

// sessionStorage throws, rather than returning null, when storage is blocked
// (Safari private mode, a hardened profile). Losing the remembered token is a
// re-prompt; letting it throw here would leave the page dead before it renders.
function readStoredToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeToken(value: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, value);
  } catch {
    /* not remembering the token is survivable; failing the unlock is not */
  }
}

let token = readStoredToken();

// A magic link (`…/#k=<token>`) hands this page a working token so the user
// never types one. Adopted into the same sessionStorage slot the unlock form
// writes, then stripped from the address bar: a token that has since been
// rotated must present as the unlock form, and a hash left in place would make
// every reload retry the dead secret instead.
// A link beats a stored token on purpose: it was minted against the server that
// is running now, while sessionStorage may hold one from a previous boot.
const linkToken = tokenFromHash(location.hash);
if (linkToken) {
  token = linkToken;
  storeToken(token);
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    // Same defence, and the same reason, as readStoredToken/storeToken above:
    // an opaque origin (a sandboxed iframe without allow-same-origin) breaks
    // the History API and sessionStorage together. This is a module script, so
    // an uncaught throw here would abandon the rest of this file — no render,
    // no listeners, a dead page — to avoid a visible `#k=` in the address bar.
    // A visible fragment is a cosmetic loss; the page is not.
  }
}

let rows: DashRow[] = [];
let stream: EventSource | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let reprobing = false;

function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function setConn(state: "connecting" | "live" | "lost"): void {
  conn.dataset.state = state;
  conn.textContent = state;
}

function showNotice(message: string): void {
  notice.textContent = message;
  notice.hidden = false;
  // Clear the previous timer, or a second notice inherits the first one's
  // remaining time and vanishes early.
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    notice.hidden = true;
  }, NOTICE_MS);
}

// Every action the row buttons can take. Downloads and seeds expose different
// sets; `delete` also removes the files, which is why it is offered only where
// the TUI offers it.
const DOWNLOAD_ACTIONS = ["pause", "resume", "remove"] as const;
const SEED_ACTIONS = ["stop-seed", "delete"] as const;

// Gate the irreversible actions. pause, resume and stop-seed are all undone by
// the button next to them, so they fire immediately; remove discards a torrent
// and delete erases files from disk, and this dashboard is meant to be used from
// a phone where those buttons sit a few millimetres from `pause`.
//
// Native confirm() deliberately: synchronous, unmissable, and no markup of its
// own. Both of those are virtues when the next step cannot be undone.
function confirmAction(action: string, name: string): boolean {
  const label = shortName(name);
  if (action === "delete") {
    return confirm(
      `Delete “${label}” and erase its downloaded files from disk?\n\nThis cannot be undone.`,
    );
  }
  if (action === "remove") {
    return confirm(
      `Remove “${label}” from the queue?\n\nFiles already downloaded are kept on disk.`,
    );
  }
  return true;
}

function metaLine(row: DashRow): string {
  if (row.kind === "seed") {
    return `${row.status} · ${row.peers} peers · ${formatBytes(row.uploaded)} up · ${formatRate(row.rate)}`;
  }
  return `${row.status} · ${row.percent}% · ${row.peers} peers · ${formatRate(row.rate)}`;
}

// Every node below is built with createElement and filled with textContent.
// A torrent's display name comes from a magnet link, i.e. from whoever wrote
// the magnet — so an innerHTML path here is stored XSS. There is no innerHTML,
// insertAdjacentHTML, or document.write anywhere in this file, and there must
// never be one.
function renderRow(row: DashRow): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row";

  const head = document.createElement("div");
  head.className = "row-head";

  const name = document.createElement("span");
  name.className = "row-name";
  name.textContent = row.name;
  // The full name for the truncated ones. `title` is an attribute, not markup.
  name.title = row.name;

  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = metaLine(row);
  head.append(name, meta);

  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("span");
  // percent is already clamped to 0..100 by dashboard.ts, so this cannot smuggle
  // anything into the style attribute.
  fill.style.width = `${row.percent}%`;
  bar.append(fill);

  const actions = document.createElement("div");
  actions.className = "row-actions";
  // Play goes first and is the only highlighted control in the row: it is the
  // one thing here that isn't queue housekeeping. Not on every row — see
  // isPlayable in streamFlow.ts for which rows and why.
  if (isPlayable(row)) {
    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "play";
    playButton.textContent = "play";
    playButton.addEventListener("click", () => void play(row));
    actions.append(playButton);
  }
  const available: readonly string[] = row.kind === "seed" ? SEED_ACTIONS : DOWNLOAD_ACTIONS;
  for (const action of available) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action;
    button.addEventListener("click", () => {
      if (!confirmAction(action, row.name)) return;
      void control(row.id, action);
    });
    actions.append(button);
  }

  li.append(head, bar, actions);
  return li;
}

function render(): void {
  emptyNote.classList.remove("error");
  emptyNote.textContent = EMPTY_TEXT;
  emptyNote.hidden = rows.length > 0;
  rowsList.replaceChildren(...rows.map(renderRow));
  // The queue tab carries its own count so a search that added something shows
  // it without switching panes — otherwise "did that work?" needs a click.
  queueCount.textContent = rows.length > 0 ? String(rows.length) : "";
  queueCount.hidden = rows.length === 0;
}

// The server's error envelope. Read defensively: a proxy or a crash can return
// something that is not this shape at all.
interface ApiError {
  error?: string;
  outcome?: string;
}

// A response body as a plain object, or {} for anything that is not one —
// including a body that never arrives and a proxy's HTML error page.
async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function readEnvelope(res: Response): Promise<ApiError> {
  return (await readJson(res)) as ApiError;
}

async function control(id: string, action: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/control", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
  } catch {
    showNotice(`${action} failed — the server is not responding.`);
    setConn("lost");
    return;
  }
  if (res.ok) return;
  const body = await readEnvelope(res);
  showNotice(body.error ?? `${action} failed (HTTP ${res.status}).`);
}

// ---- streaming ------------------------------------------------------------
// Everything below to the next banner is the Play flow. The decisions live in
// streamFlow.ts; what is here is fetch, timers and DOM.

// Rows with a Play already in flight. Starting a session takes a round trip and
// then up to minutes of polling, and the row's buttons are rebuilt four times a
// second by the SSE tick — so without this a second tap starts a second session
// (a second swarm, a second Real-Debrid job) for the same torrent.
const playing = new Set<string>();

// The session the picker is currently offering. Held so Cancel can stop it: the
// session is live by then, with a torrent attached, and closing the picker
// without stopping it would leave that running until the idle reaper notices.
let pickerSession: string | null = null;

// How the open picker's list is ordered, and how to draw it again. Both are
// module-level for the same reason `pickerSession` is: there is one picker card
// in the page, so a second play() replaces the list wholesale and these follow
// it. (The infoHash deliberately does NOT live up here — see showPicker.)
//
// The mode survives a second play() on purpose: someone who prefers biggest-first
// prefers it for the next torrent too, exactly as the TUI's `s` sticks for as long
// as its picker is open. It is not persisted to config — the TUI's isn't either.
let pickerMode: StreamFileSort = "name";
let drawPicker: (() => void) | null = null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function startSession(row: DashRow, confirmed: boolean): Promise<StartResult> {
  let res: Response;
  try {
    res = await fetch("/api/stream", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      // A queue item's id IS its info hash, and the server rebuilds a magnet
      // with the default tracker list from it — so the row carries everything
      // the session needs and the status payload doesn't have to ship magnets.
      // `confirm` is sent only when a human said yes; it is never defaulted.
      body: JSON.stringify({
        infoHash: row.id,
        name: row.name,
        ...(confirmed ? { confirm: true } : {}),
      }),
    });
  } catch {
    showNotice("Play failed — the server is not responding.");
    setConn("lost");
    return { kind: "failed" };
  }

  if (res.status === 409) {
    const body = (await readJson(res)) as Partial<StreamConfirmResponse>;
    // A 409 with an unreadable body still has to prompt. Falling through to
    // "failed" would be safe, but falling through to *proceeding* would not, so
    // the missing-reason case is a prompt with a vague reason, never a silent
    // one either way.
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : "it is configured but not usable right now";
    return { kind: "confirm", reason };
  }
  if (!res.ok) {
    const body = await readEnvelope(res);
    showNotice(body.error ?? `Play failed (HTTP ${res.status}).`);
    return { kind: "failed" };
  }

  const body = (await readJson(res)) as Partial<StartStreamResponse>;
  if (
    typeof body.sessionId !== "string" ||
    typeof body.capability !== "string" ||
    !body.session ||
    typeof body.session !== "object"
  ) {
    showNotice("Play failed — the server sent something unreadable.");
    return { kind: "failed" };
  }
  return {
    kind: "started",
    sessionId: body.sessionId,
    capability: body.capability,
    session: body.session,
  };
}

async function pollSession(sessionId: string): Promise<PublicStreamSession | null> {
  try {
    const res = await fetch(`/api/stream/${encodeURIComponent(sessionId)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as PublicStreamSession) : null;
  } catch {
    return null;
  }
}

// Best effort, and nothing waits on it: a session we are walking away from
// should not hold a torrent open, but failing to say so is not worth a second
// error message on top of the one that got us here.
function stopSession(sessionId: string): void {
  void fetch(`/api/stream/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  }).catch(() => {});
}

// Navigate this tab, rather than window.open(): by the time a session is ready
// the click that started it is seconds or minutes old, so the popup has lost its
// user activation and every browser blocks it — and on a phone there is nowhere
// useful for a second tab to go anyway. The player page carries a "back to
// queue" link.
//
// The session is deliberately NOT stopped here. It is what the player is about
// to fetch. Nothing in this tab outlives the navigation, so a session whose
// player tab is simply closed is cleaned up by the registry's idle reaping —
// the player page cannot DELETE it itself, having a capability but no token.
function openPlayer(path: string): void {
  location.assign(path);
}

function hidePicker(): void {
  pickerSession = null;
  drawPicker = null;
  picker.hidden = true;
  pickerFiles.replaceChildren();
}

// Same createElement/textContent rule as renderRow, and for a stronger reason:
// these strings are filenames from inside a stranger's torrent.
//
// `infoHash` is a PARAMETER, not a module-level variable read when a file is
// chosen. The picker is an inline card, not a modal (index.html's `.picker` is
// `display: block`), so the results list stays clickable while it is open —
// clicking play on a different row opens a second picker for a different
// torrent. A module-level "current picker hash" would be overwritten by that
// second play(), and choosing a file from the FIRST picker would then record
// its filename as watched against the SECOND torrent's favourite. Closing over
// the hash at the call site (see play()) makes that impossible: each picker's
// callbacks carry the hash they were opened with, for good.
//
// `preselect` is streamOutcome's decision (streamFlow.ts), never one made here:
// which file is the next episode is shared with the TUI's picker, and app.ts is
// wiring. All this does with it is mark the row, say so in a word, and put the
// keyboard on it — pressing Enter then plays the episode the Continue-watching
// row promised, which is the browser's equivalent of the TUI's opening cursor.
//
// The ORDER rows appear in is `pickerRows`' decision for the same reason, and the
// re-draw the sort button triggers goes through it too: which row is which after a
// re-sort is exactly the sort of conditional that must not live in this file.
function showPicker(
  infoHash: string,
  sessionId: string,
  capability: string,
  name: string,
  files: PublicStreamFile[],
  preselect: number | null,
): void {
  pickerSession = sessionId;
  pickerTitle.textContent = `Which file from “${shortName(name)}”?`;

  // `keep` is the file the user already had the keyboard on, as an index into
  // `files` — read out of the live DOM rather than tracked, so nothing here has
  // to stay in step with focus moving by tab, click or arrow key. Omitted on the
  // first draw, which is a different thing from "nothing focused"; pickerRows
  // owns that distinction.
  const draw = (keep?: number | null): void => {
    const rows = pickerRows(files, pickerMode, preselect, keep);
    pickerSort.textContent = `sort: ${pickerMode}`;
    pickerFiles.replaceChildren(
      ...rows.files.map((file, index) => {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "picker-file";
        button.textContent = fileLabel(file);
        button.title = file.filename;
        // Which file this row is, for the focus lookup on the next re-sort.
        // The session's own index, which is what identifies a file everywhere
        // else on the wire.
        button.dataset["file"] = String(file.index);
        if (index === rows.preselect) {
          button.classList.add("picker-file-next");
          button.setAttribute("aria-current", "true");
          // createElement + textContent, as everywhere on this page.
          const tag = document.createElement("span");
          tag.className = "picker-next";
          tag.textContent = "next";
          button.append(tag);
        }
        button.addEventListener("click", () => {
          // hidePicker() clears pickerSession, so the Cancel handler can no longer
          // stop the session we are about to hand to the player.
          hidePicker();
          // Fire-and-forget, and only once a file was actually chosen. The server
          // no-ops when this torrent is not favourited, so there is nothing to
          // check here and nothing to wait for — the same shape as the TUI's
          // markPlayed, which also records only after a player launches.
          void postSaved(
            "/api/library",
            libraryBody({ infoHash, name }, "watched", file.filename),
          );
          openPlayer(playerPath(sessionId, file, capability));
        });
        li.append(button);
        return li;
      }),
    );
    // After the list is in the document, and read back out of the DOM rather than
    // closed over: a focus() on a hidden element does nothing at all.
    if (rows.focus !== null) {
      const target = pickerFiles.children[rows.focus]?.firstElementChild;
      if (target instanceof HTMLElement) target.focus();
    }
  };

  picker.hidden = false;
  // Only a re-sort has a file to keep; opening the picker follows the preselect.
  drawPicker = () => draw(focusedPickerFile(files));
  draw();
}

// The row the keyboard is on, as an index into `files`, or null when focus is
// somewhere else on the page entirely (the sort button itself, most often).
function focusedPickerFile(files: PublicStreamFile[]): number | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const at = active.dataset["file"];
  if (at === undefined) return null;
  const found = files.findIndex((f) => String(f.index) === at);
  return found >= 0 ? found : null;
}

pickerCancel.addEventListener("click", () => {
  const sessionId = pickerSession;
  hidePicker();
  if (sessionId) stopSession(sessionId);
});

// The TUI picker's `s` key. The mode flips (nextSort, shared with that picker) and
// the open list is drawn again; with no picker open there is nothing to draw and
// the button is not on screen to be pressed.
pickerSort.addEventListener("click", () => {
  pickerMode = nextSort(pickerMode);
  drawPicker?.();
});

// The flow itself is runPlay in streamFlow.ts, where a unit test can reach it —
// including the two rules that matter, the torrent-confirm prompt and the
// keep-polling-while-resolving loop. Everything bound here is an effect:
//
// `confirm` is the native dialog, deliberately, for the same reason the delete
// gate uses it. Synchronous and unmissable are the right properties for a
// decision whose consequence (your IP in a public swarm) cannot be taken back.
//
// `onUnresolved`, when given, is `runPlay`'s own effect for "start could not
// start a session at all" (a dead swarm, an unreachable server) — the
// at-most-once guarantee is runPlay's, not re-derived here (see PlayEffects'
// doc comment in streamFlow.ts). The one caller that needs to react to it is
// Continue watching, whose "remembered torrent won't resolve" fallback is a
// search, not just the notice `startSession` already showed. Every other
// caller passes nothing and behaves exactly as before.
// `next`, when given, is a Continue-watching row's own suggested episode — the
// server's `nextEpisode` over that row's high-water mark. Callers that have no
// row (a search hit, a library entry, a queue row) pass nothing, and
// wantedEpisodeFor looks one up by title so EVERY play path preselects, as every
// TUI play path does. Both the lookup and the precedence are its decision; the
// only thing here is which two values to hand it.
async function play(
  row: DashRow,
  onUnresolved?: () => void,
  next?: EpisodeRef | null,
): Promise<void> {
  if (playing.has(row.id)) return;
  playing.add(row.id);
  const wanted = wantedEpisodeFor(row.name, savedState.continueWatching, next);
  try {
    await runPlay(row, {
      start: startSession,
      poll: pollSession,
      stop: stopSession,
      confirm: (message) => confirm(message),
      notice: showNotice,
      // Closes over THIS row's hash, not a module-level variable — see
      // showPicker's comment for why that distinction is load-bearing.
      choose: (sessionId, capability, name, files, preselect) =>
        showPicker(row.id, sessionId, capability, name, files, preselect),
      open: (path) => openPlayer(path),
      sleep,
      now: () => Date.now(),
      onUnresolved,
    }, wanted);
  } finally {
    playing.delete(row.id);
  }
}

// ---- playback preferences ---------------------------------------------------
// The header disclosure. It affects For You and the Continue-watching rows
// under Saved (see index.html's comment on #prefs for why it lives here and
// not in either pane). All it does is read/write PublicQualityPrefs through
// POST /api/preferences and paint the rows FEATURES describes — no ranking
// decision is made in this file; that is pickModel.ts/releasePick.ts's job.

let prefs: PublicQualityPrefs = { maxResolution: null, require: [], exclude: [] };

function stateOf(id: (typeof FEATURE_IDS)[number]): FeatureState {
  if (prefs.exclude.includes(id)) return "exclude";
  if (prefs.require.includes(id)) return "require";
  return "off";
}

async function savePrefs(next: PublicQualityPrefs): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/preferences", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", preferences: next }),
    });
  } catch {
    showNotice("That didn't reach the server.");
    setConn("lost");
    return;
  }
  if (!res.ok) {
    const body = await readEnvelope(res);
    showNotice(body.error ?? `That didn't stick (HTTP ${res.status}).`);
    return;
  }
  // Trust the server's echo, not the local guess: it re-reads and sanitises,
  // so an id this build sent but the server rejected must not linger in the UI.
  prefs = ((await res.json()) as PreferencesResponse).preferences;
  renderPrefs();
}

function renderPrefs(): void {
  prefsFeaturesBox.replaceChildren();
  prefsResSelect.value = prefs.maxResolution ?? "";
  for (const id of FEATURE_IDS) {
    const state = stateOf(id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pref-feature";
    btn.dataset.state = state;
    btn.textContent = `${FEATURE_STATE_MARK[state]} ${FEATURES[id].label}`;
    btn.setAttribute("aria-label", `${FEATURES[id].label}: ${state}`);
    btn.addEventListener("click", () => {
      const next = NEXT_FEATURE_STATE[state];
      void savePrefs({
        maxResolution: prefs.maxResolution,
        require: next === "require" ? [...prefs.require, id] : prefs.require.filter((x) => x !== id),
        exclude: next === "exclude" ? [...prefs.exclude, id] : prefs.exclude.filter((x) => x !== id),
      });
    });
    prefsFeaturesBox.appendChild(btn);
  }
}

prefsResSelect.addEventListener("change", () => {
  const value = prefsResSelect.value;
  void savePrefs({ ...prefs, maxResolution: (value || null) as PublicQualityPrefs["maxResolution"] });
});

// `prefs` is otherwise only ever set at boot and from this tab's own POST
// echo, so another surface changing the stored preference (the TUI's `P`,
// or another browser tab) would sit unseen until reload — and the next click
// here would build its whole-object POST from that stale snapshot and quietly
// wipe the other surface's change. Re-read the moment the disclosure opens,
// through the same fetch `loadSources()` already does, so there is no second
// endpoint or parse path for the same data.
prefsBlock.addEventListener("toggle", () => {
  if (prefsBlock.open) void loadSources();
});

// ---- search ---------------------------------------------------------------
// Everything to the next banner is the search pane. As with Play, the decisions
// live in pure modules — searchModel.ts and previewModel.ts — and what is here
// is EventSource, fetch and DOM.

// Search opens first. This app is a torrent finder; a queue monitor is what it
// looks like when it opens on the queue. The Queue tab carries a count so
// nothing in flight is out of sight.
type ViewName = "search" | "recc" | "saved" | "queue";
let view: ViewName = "search";

let searchView: SearchView = emptyView();
let sources: SourcesResponse | null = null;
let searchStream: EventSource | null = null;
// Lowercase info hashes the active provider has cached, straight from
// POST /api/cached. Empty whenever the provider can't answer (see cachedTag) —
// there is no "unknown" state, only cached or not-shown.
let cachedHashes: ReadonlySet<string> = new Set();
// Bumped on every startSearch so a cached-check answer that lands after a newer
// search has already begun cannot paint stale badges onto this search's rows —
// the same failure mode a marker on the wrong row would be.
let cachedGeneration = 0;
// The info hash of the row whose preview is showing, so a re-render can restore
// the selection: the results list is rebuilt on every snapshot frame, and up to
// 23 of those arrive during one search.
let selectedHash: string | null = null;

// Remembered across reloads, and read through parseLayout because localStorage
// is user-writable. Wrapped in try/catch for the reason readStoredToken is:
// storage throws rather than returning null when it is blocked (Safari private
// mode, a hardened profile), and a dead page is a worse outcome than a
// forgotten preference.
const LAYOUT_KEY = "torlnk.layout";

function readStoredLayout(): ResultLayout {
  try {
    return parseLayout(localStorage.getItem(LAYOUT_KEY));
  } catch {
    return "list";
  }
}

let layout: ResultLayout = readStoredLayout();

function showView(next: ViewName): void {
  view = next;
  paneSearch.hidden = next !== "search";
  paneRecc.hidden = next !== "recc";
  paneSaved.hidden = next !== "saved";
  paneQueue.hidden = next !== "queue";
  viewSearchTab.setAttribute("aria-pressed", String(next === "search"));
  viewReccTab.setAttribute("aria-pressed", String(next === "recc"));
  viewSavedTab.setAttribute("aria-pressed", String(next === "saved"));
  viewQueueTab.setAttribute("aria-pressed", String(next === "queue"));
  // The feed's first load happens here and nowhere else — `open()` is a no-op
  // after the first call, so this is "the tab has been visited", not "fetch
  // again". Nothing asks reccd for anything until a human opens this pane.
  if (next === "recc") recc.open();
  // Refetched on every visit, not once: a favourite added from a search row
  // while this pane sat hidden must be here when the user opens it, and the
  // response is two small arrays.
  if (next === "saved") void loadSaved();
}

viewSearchTab.addEventListener("click", () => showView("search"));
viewReccTab.addEventListener("click", () => showView("recc"));
viewSavedTab.addEventListener("click", () => showView("saved"));
viewQueueTab.addEventListener("click", () => showView("queue"));

// The tab strip, from GET /api/sources. The adult category is absent from that
// response when it is off, so a "Porn" tab cannot be built here — the server's
// `sourcesByGroup(adultEnabled)` is the single place that decision is made, and
// a second check in the browser would be a second place for it to be wrong.
function renderTabs(): void {
  tabsBar.replaceChildren(
    ...categoryTabs(sources).map((group) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tab";
      button.textContent = group;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(group === searchView.group));
      button.addEventListener("click", () => {
        const plan = tabClickPlan(searchView, group, queryInput.value);
        if (plan.action === "ignore") return;
        searchView = { ...searchView, group };
        renderTabs();
        startSearch(plan.query);
      });
      return button;
    }),
  );
}

async function loadSources(): Promise<void> {
  try {
    const res = await fetch("/api/sources", { headers: authHeaders() });
    if (!res.ok) return;
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object") return;
    sources = body as SourcesResponse;
    // The one thing the browser fetches before it can render anything also
    // carries the stored preference (wire.ts's SourcesResponse.preferences
    // doc comment) — so the header disclosure opens on it rather than on
    // the placeholder default for however long the search results take.
    prefs = sources.preferences;
  } catch {
    // A tab strip we cannot build is survivable — "All" still searches
    // everything, and the source badges fall back to raw ids. Failing the whole
    // page for it would not be.
    return;
  }
  renderTabs();
  renderResults();
  renderPrefs();
}

function stopSearch(): void {
  searchStream?.close();
  searchStream = null;
}

/**
 * `POST /api/cached` for the settled search's rows, fired after results are
 * already on screen — never awaited by anything that would delay rendering.
 *
 * Skipped entirely when `sources?.debridCachedCheck` is false, which is how a
 * Real-Debrid browser never asks a question the server would 409: the browser
 * already knows the capability from `/api/sources` and doesn't have to find
 * out the hard way. `cachedGeneration` guards the async reply landing after a
 * newer search has started — a badge from a discarded query answered on this
 * one's rows would be worse than no badge at all.
 */
function refreshCachedHashes(): void {
  if (sources?.debridCachedCheck !== true) return;
  const hashes = [...new Set((searchView.snapshot?.results ?? []).map((r) => r.infoHash))];
  if (hashes.length === 0) return;
  const generation = cachedGeneration;
  void (async () => {
    let res: Response;
    try {
      res = await fetch("/api/cached", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ hashes }),
      });
    } catch {
      return;
    }
    if (!res.ok || generation !== cachedGeneration) return;
    const body = await readJson(res);
    if (!Array.isArray(body.cached) || generation !== cachedGeneration) return;
    cachedHashes = new Set(body.cached.filter((h): h is string => typeof h === "string"));
    renderResults();
  })();
}

function startSearch(raw: string): void {
  stopSearch();
  // Trimmed here, once, so every caller — including searchForPick, which hands
  // over an untrusted title from reccd — gets the same normalisation the server
  // applies before it decides search vs. browse (parseSearchParams).
  const query = raw.trim();
  // An empty query is browse mode, not a mistake — the server accepts it and
  // most sources answer with their own top/latest list; a couple opt out.
  const mode = modeForQuery(query);
  searchView = { ...searchView, query, mode, snapshot: null, running: true };
  // The box and the state must not disagree: without this, submitting "   "
  // leaves #query showing whitespace while searchView.query (and the URL sent
  // to the server) is already trimmed.
  queryInput.value = query;
  selectedHash = null;
  preview.select(null, searchView.group);
  // A new search is the only moment the whole set of rows changes, so it is the
  // only moment every blob is certainly dead.
  resultPosters.clear();
  // Stale cached markers are worse than none: a marker on the wrong row. Bump
  // the generation FIRST so an in-flight /api/cached reply from the previous
  // search cannot land after this reset and repaint badges onto these rows.
  cachedGeneration += 1;
  cachedHashes = new Set();
  paintSearchHint();
  renderResults();

  const source = new EventSource(searchUrl(query, searchView.group, token));
  searchStream = source;

  const frame = (event: Event): PublicSearchSnapshot | null => {
    try {
      return JSON.parse((event as MessageEvent<string>).data) as PublicSearchSnapshot;
    } catch {
      return null;
    }
  };

  source.addEventListener("results", (event) => {
    if (source !== searchStream) return;
    const snapshot = frame(event);
    if (!snapshot) return;
    searchView = { ...searchView, snapshot };
    renderResults();
  });
  source.addEventListener("done", (event) => {
    if (source !== searchStream) return;
    const snapshot = frame(event);
    searchView = { ...searchView, running: false, ...(snapshot ? { snapshot } : {}) };
    // The server ends the connection after `done`; closing here as well stops
    // EventSource treating that end as a drop and reconnecting — which would
    // silently re-run the whole 23-source fan-out.
    stopSearch();
    renderResults();
    refreshCachedHashes();
  });
  source.addEventListener("error", (event) => {
    if (source !== searchStream) return;
    // `error` is a frame the server sends (config unreadable) as well as
    // EventSource's own transport event, which carries no data. Both mean this
    // search is over — but they mean different things to the user, and the
    // server's version already says what went wrong, so say it rather than
    // replacing it with a generic line.
    const body = frame(event) as { error?: unknown } | null;
    stopSearch();
    searchView = { ...searchView, running: false };
    if (body === null) showNotice("The search connection dropped.");
    else if (typeof body.error === "string" && body.error.trim()) showNotice(body.error);
    renderResults();
  });
}

/**
 * One search across every source, resolved once instead of streamed.
 *
 * The same transport `startSearch` drives (`GET /api/search`, `EventSource`,
 * `searchUrl`) — there is no separate one-shot search route, so this is that
 * transport collected to a Promise rather than a second way to ask the
 * server for results. It runs on its own `EventSource`, independent of
 * `searchStream`: the pane's own in-progress search (or lack of one) must not
 * be disturbed by a Play button's background lookup, and vice versa.
 */
function searchOnce(title: string): Promise<PublicSearchResult[]> {
  return new Promise((resolve) => {
    const source = new EventSource(searchUrl(title, ALL_TAB, token));
    let latest: PublicSearchResult[] = [];
    const frame = (event: Event): PublicSearchSnapshot | null => {
      try {
        return JSON.parse((event as MessageEvent<string>).data) as PublicSearchSnapshot;
      } catch {
        return null;
      }
    };
    const finish = (results: PublicSearchResult[]): void => {
      source.close();
      resolve(results);
    };
    source.addEventListener("results", (event) => {
      const snapshot = frame(event);
      if (snapshot) latest = snapshot.results;
    });
    source.addEventListener("done", (event) => {
      const snapshot = frame(event);
      finish(snapshot ? snapshot.results : latest);
    });
    // A transport drop is not a reason to hang the picker forever — resolve
    // with whatever arrived before it, same as the live pane's own `error`
    // handler treats an incomplete snapshot as the final one.
    source.addEventListener("error", () => finish(latest));
  });
}

/**
 * The one-click Play flow behind both a For You film card and a Continue
 * Watching row: search, rank against the current preference, play. Owned by
 * pickModel.ts's `createPickController` — the staleness counter (a slow
 * search resolving after a newer one is discarded, not played under the
 * newer title's status) and the `onNone` fallback both live there, not here.
 */
const pickController = createPickController<PublicSearchResult>({
  search: (title) => searchOnce(title),
  // Read fresh on every call: the header disclosure can change the
  // preference while a search is in flight, and start() itself is the one
  // place that reads it once and keeps that snapshot for the whole pick.
  prefs: () => prefsFromWire(prefs),
  play: (pick, intent) => {
    // pick.fromPack means the winner is a season pack, so the episode inside
    // still has to be selected — the same `next` hint playContinueWatching
    // already hands to play() for a Continue-watching row that names one.
    const next = pick.fromPack && intent.kind === "episode"
      ? { season: intent.season, episode: intent.episode }
      : undefined;
    void play(rowForPlay(pick.chosen), undefined, next);
  },
  render: (state) => renderPickPhase(state),
});

// Pure DOM: switch on state.phase.kind and paint the four variants into the
// existing notice area. It decides nothing — the phase already says what to
// show, and the "playing" note is pickStatusLine's output, computed inside
// the controller.
function renderPickPhase(state: PickState): void {
  const phase = state.phase;
  if (phase.kind === "searching") showNotice(pickSearchingLine(phase.title));
  else if (phase.kind === "playing") showNotice(phase.note);
  else if (phase.kind === "none") showNotice(pickNoneLine(phase.title));
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  // No guard on an empty value: submitting a blank box is how you browse the
  // top lists, the same as pressing Enter on an empty box in the TUI.
  startSearch(queryInput.value);
});

// Saves whatever is in the box, submitted or not: the thing worth keeping is
// the query you just typed, and requiring a search first would mean running one
// to save one.
saveSearchButton.addEventListener("click", () => {
  const query = queryInput.value.trim();
  if (!query) {
    showNotice("Type a search to save it.");
    return;
  }
  void toggleSavedSearch(query);
});

sortSelect.addEventListener("change", () => {
  // parseSort is the TUI's own parser, so "seeders:desc" means the same thing
  // in both places and anything unrecognised falls back to the server's order.
  searchView = { ...searchView, sort: parseSort(sortSelect.value) };
  renderResults();
});

filterInput.addEventListener("input", () => {
  searchView = { ...searchView, textFilter: filterInput.value };
  renderResults();
});

aliveCheck.addEventListener("change", () => {
  searchView = { ...searchView, hideDead: aliveCheck.checked };
  renderResults();
});

layoutSelect.addEventListener("change", () => {
  layout = parseLayout(layoutSelect.value);
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* not remembering the layout is survivable; failing the click is not */
  }
  // No refetch: both layouts render from the same visibleResults output and the
  // same poster cache, so a toggle costs nothing.
  renderResults();
});

// One cache for the whole page. Cleared when a new search starts — the only
// moment the set of rows changes wholesale — which revokes every blob it holds.
const resultPosters = createPosterCache({
  async fetchMeta(release, group): Promise<PublicTitleMeta | null> {
    const params = new URLSearchParams({ release });
    // The group, not a parsed hint: the server maps it (hintForGroup) so the
    // browser never has to know that "TV" means OMDb's "series".
    if (group && group !== ALL_TAB) params.set("group", group);
    try {
      const res = await fetch(`/api/title?${params.toString()}`, { headers: authHeaders() });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      return body && typeof body === "object" ? (body as PublicTitleMeta) : null;
    } catch {
      return null;
    }
  },
  async fetchBlob(posterUrl): Promise<string | null> {
    // Through /api/poster, never an <img src> at the CDN: that would leak the
    // user's IP and referer on every row, which is why that route exists. It is
    // also behind the bearer token, and an <img> cannot send a header.
    try {
      const res = await fetch(posterPath(posterUrl), { headers: authHeaders() });
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    } catch {
      return null;
    }
  },
  revoke: (url) => URL.revokeObjectURL(url),
});

/** The page's single "no OMDb key" line. The decision lives in resultPosters.ts's `searchHint`. */
function paintSearchHint(): void {
  const hint = searchHint(sources ? sources.omdbConfigured : null, searchView.group, resultPosters.hint());
  searchHintLine.textContent = hint ?? "";
  searchHintLine.hidden = hint === null;
}

/**
 * Paint one poster frame.
 *
 * `compact` is the row thumbnail, where the frame is 3.5rem wide and "NO OMDB
 * KEY" does not fit — it gets an empty box with the wording on `title`, and the
 * page's hint line carries the explanation. A grid card's frame is poster-width,
 * so it shows the note as text the way the For You cards do.
 */
function paintPoster(host: HTMLElement, outcome: PosterOutcome, compact: boolean): void {
  if (outcome.kind === "poster") {
    const img = document.createElement("img");
    img.src = outcome.url;
    img.alt = "";
    host.replaceChildren(img);
    return;
  }
  const note = resultPosters.note(outcome);
  const span = document.createElement("span");
  span.className = "poster-note";
  span.textContent = compact ? "" : note;
  // An attribute, not markup — and the only way the compact frame says anything.
  span.title = note;
  host.replaceChildren(span);
}

// ONE observer for the page, not one per row, and this is the same hazard
// resultPosters.ts exists for — one layer up.
//
// The results list is rebuilt on every snapshot frame, up to 23 a search. A row
// whose poster has not settled yet has nothing to paint, so a per-row
// `new IntersectionObserver(...)` would be constructed again on every frame —
// and `disconnect()` only ever runs on intersect, so every row that never
// scrolls into view leaves its observer alive holding a detached frame (the old
// `li` having been discarded by `replaceChildren`). A 100-row browse across 23
// frames is ~2300 live observers pinning dead nodes. Exactly the 23×-fetch,
// 22-leaked-blob failure the cache prevents, in a different currency.
//
// One observer, disconnected wholesale at the top of every render and re-armed
// on the new frames, cannot accumulate: after `disconnect()` it observes exactly
// the frames now on the page.
const posterObserver: IntersectionObserver | null =
  // No IntersectionObserver (an old browser, a non-DOM environment) means fetch
  // eagerly instead — a missing optimisation must not become a missing feature.
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          // Stop watching this frame specifically; the others stay armed.
          posterObserver?.unobserve(entry.target);
          const pending = posterTargets.get(entry.target);
          if (pending) startPoster(pending.release, entry.target as HTMLElement, pending.compact);
        }
      })
    : null;

// What each observed frame is waiting for. A WeakMap so a frame discarded by a
// re-render is collectable — a Map keyed on elements would be the leak this
// design is avoiding, just spelled differently.
const posterTargets = new WeakMap<Element, { release: string; compact: boolean }>();

function startPoster(release: string, host: HTMLElement, compact: boolean): void {
  const outcome = resultPosters.want(release, searchView.group);
  if (!(outcome instanceof Promise)) {
    paintPoster(host, outcome, compact);
    return;
  }
  void outcome.then((settledOutcome) => {
    // The row may have been re-rendered or filtered away during the two round
    // trips; a detached node is not worth painting.
    if (host.isConnected) paintPoster(host, settledOutcome, compact);
    paintSearchHint();
  });
}

/**
 * Mount a row's poster, lazily.
 *
 * Lazy because a browse can return 100+ rows, and fetching artwork for rows
 * nobody scrolled to would spend a daily-capped OMDb key on them. For You is
 * naturally ~20 picks and needs no such gate, which is why its own mount is
 * eager.
 */
function mountResultPoster(release: string, host: HTMLElement, compact: boolean): void {
  const known = resultPosters.peek(release);
  if (known !== undefined) {
    // Settled already: paint it and never observe it. This is the path almost
    // every frame of a re-render takes, and it is why the observer set stays
    // small after the first pass.
    paintPoster(host, known, compact);
    return;
  }
  // An empty frame while it waits — NOT paintPoster's "none", which would put
  // "No poster" on a grid card before anything had been asked. The CSS gives the
  // frame its border and 2:3 box, so an empty one is a placeholder rather than a
  // hole, and the row does not resize when the image lands.
  host.replaceChildren();
  if (posterObserver === null) {
    startPoster(release, host, compact);
    return;
  }
  posterTargets.set(host, { release, compact });
  posterObserver.observe(host);
}

// The four buttons a result offers, built once and used by both layouts: a
// grid card that offered fewer of them than the list row would be a downgrade
// dressed as a view option.
function resultActions(result: PublicSearchResult): HTMLDivElement {
  const actions = document.createElement("div");
  actions.className = "row-actions";

  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "play";
  playButton.textContent = "play";
  playButton.addEventListener("click", () => void play(rowForPlay(result)));
  actions.append(playButton);

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.textContent = "add";
  addButton.addEventListener("click", () => void addResult(result, "p2p"));
  actions.append(addButton);

  // Labelled by what the click will do, and rebuilt from savedState on every
  // render — the results list is re-rendered on every snapshot frame, so a
  // hardcoded label here would go stale within a second of being clicked.
  const inLibrary = isInLibrary(savedState, result.infoHash);
  const favButton = document.createElement("button");
  favButton.type = "button";
  favButton.textContent = favouriteLabel(inLibrary);
  favButton.setAttribute("aria-pressed", String(inLibrary));
  favButton.addEventListener("click", () => {
    const input: LibraryInput = { infoHash: result.infoHash, name: result.name };
    if (result.sizeBytes > 0) input.sizeBytes = result.sizeBytes;
    if (result.source) input.source = result.source;
    void toggleLibrary(input);
  });
  actions.append(favButton);

  // Offered only where the TUI offers `r`: when a debrid token is actually
  // configured. A button that always answered "set a token first" is noise.
  // `debridProvider` guards against `debridConfigured: true` with a null
  // provider producing a button labelled "add via null".
  if (sources?.debridConfigured && sources.debridProvider) {
    const debridButton = document.createElement("button");
    debridButton.type = "button";
    debridButton.textContent = debridAddLabel(sources.debridProvider);
    debridButton.addEventListener("click", () => void addResult(result, "debrid"));
    actions.append(debridButton);
  }

  return actions;
}

// createElement + textContent only — see the file-level rule. `cachedTag`
// already folds in `debridCachedCheck`, so this is a straight append-or-not.
function appendCachedBadge(meta: HTMLElement, result: PublicSearchResult): void {
  const tag = cachedTag(result.infoHash, cachedHashes, sources?.debridCachedCheck === true);
  if (!tag) return;
  const badge = document.createElement("span");
  badge.className = "tag-cached";
  badge.textContent = tag;
  meta.append(badge);
}

// Same createElement/textContent rule as every other list here: a release name
// is written by whoever uploaded the torrent.
function renderResultCard(result: PublicSearchResult): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row result-card";
  li.setAttribute("aria-selected", String(result.infoHash === selectedHash));

  // The poster is the card's primary target and what it does is select the
  // result, which fills the preview pane — the same thing clicking the name
  // does in list view.
  const posterButton = document.createElement("button");
  posterButton.type = "button";
  posterButton.className = "recc-poster";
  posterButton.title = result.name;
  const frame = document.createElement("div");
  frame.className = "poster";
  posterButton.append(frame);
  posterButton.addEventListener("click", () => selectResult(result));
  // compact: false — a card's frame is poster-width, so an empty one shows its
  // note as text rather than relying on a tooltip.
  mountResultPoster(result.name, frame, false);

  const name = document.createElement("button");
  name.type = "button";
  name.className = "result-name row-name";
  name.textContent = result.name;
  name.title = result.name;
  name.addEventListener("click", () => selectResult(result));

  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = resultMeta(result, sources);
  appendCachedBadge(meta, result);

  li.append(posterButton, name, meta, resultActions(result));
  return li;
}

// Every node below is createElement + textContent. A release name is written by
// whoever uploaded the torrent, so an innerHTML path here is stored XSS from a
// stranger on a public tracker.
function renderResult(result: PublicSearchResult): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row";
  li.setAttribute("aria-selected", String(result.infoHash === selectedHash));

  const head = document.createElement("div");
  head.className = "result-head";

  const name = document.createElement("button");
  name.type = "button";
  name.className = "result-name";
  name.textContent = result.name;
  name.title = result.name;
  name.addEventListener("click", () => selectResult(result));

  const badge = document.createElement("span");
  badge.className = "result-source";
  badge.textContent = sourceLabel(sources, result.source);
  head.append(name, badge);

  const meta = document.createElement("span");
  meta.className = "result-meta";
  meta.textContent = resultMeta(result, sources);
  appendCachedBadge(meta, result);

  const actions = resultActions(result);

  const withPoster = postersApply(searchView.group, sources?.omdbConfigured === true);
  if (!withPoster) {
    li.append(head, meta, actions);
    return li;
  }

  // The row's own layout is untouched — it moves wholesale into the second grid
  // column, so a keyless page and a Games tab render exactly what they always
  // did.
  li.classList.add("result-with-poster");
  const frame = document.createElement("div");
  frame.className = "poster result-thumb";
  const body = document.createElement("div");
  body.append(head, meta, actions);
  li.append(frame, body);
  mountResultPoster(result.name, frame, true);
  return li;
}

function renderResults(): void {
  // Every frame about to be replaced stops being watched. Without this the
  // observer accumulates targets across all 23 snapshot frames of a search,
  // pinning detached nodes for every row that never scrolled into view.
  posterObserver?.disconnect();
  const shown = visibleResults(searchView, reportsHealthLookup(sources));

  // The toggle is meaningless where there is no artwork, and a grid of empty
  // frames is worse than the list it replaced — so on a Games tab, or with no
  // OMDb key, the control is hidden and the layout is forced back to list. The
  // stored preference is untouched: it applies again the moment the user is on
  // a tab that can honour it.
  const canGrid = postersApply(searchView.group, sources?.omdbConfigured === true);
  layoutControl.hidden = !canGrid;
  const effective: ResultLayout = canGrid ? layout : "list";

  resultsList.classList.toggle("recc-grid", effective === "grid");
  resultsList.classList.toggle("results-grid", effective === "grid");
  resultsList.replaceChildren(
    ...shown.map((r) => (effective === "grid" ? renderResultCard(r) : renderResult(r))),
  );

  const status = searchStatus(searchView, shown.length);
  searchStatusLine.textContent = status.text;
  searchStatusLine.classList.toggle("error", status.tone === "error");
  searchStatusLine.hidden = statusLineHidden(searchView, shown.length);
  searchProgress.textContent = searchView.snapshot
    ? `${searchView.snapshot.done}/${searchView.snapshot.total} sources`
    : "";

  // A selected row that the filters just removed keeps neither its highlight
  // nor its preview.
  if (selectedHash !== null && !shown.some((r) => r.infoHash === selectedHash)) {
    selectedHash = null;
    preview.select(null, searchView.group);
  }
  paintSearchHint();
}

function selectResult(result: PublicSearchResult): void {
  selectedHash = result.infoHash;
  renderResults();
  preview.select(previewApplies(searchView.group) ? result.name : null, searchView.group);
}

// ---- add from a result ----

async function addResult(result: PublicSearchResult, via: AddVia): Promise<void> {
  // The prompt-or-go decision is addPlan's, not this function's: it is a
  // decision about whether the user's IP is about to enter a public swarm, and
  // it belongs somewhere a test can reach.
  const plan = addPlan(
    via,
    sources?.debridConfigured === true,
    result.name,
    sources?.debridProvider ?? undefined,
  );
  if (plan.kind === "confirm" && !confirm(plan.message)) {
    showNotice("Nothing was added.");
    return;
  }

  let res: Response;
  try {
    res = await fetch("/api/add", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      // addBody carries the NAME as well as the hash. Search results have no
      // magnet on the wire (deliberately — it is ~6MB a search), and the server
      // takes a hash-only add's name from the magnet's `dn`, which there isn't
      // one of: without the name every add here is a queue row called
      // "3f2a1c…".
      body: JSON.stringify(addBody(result, plan.via)),
    });
  } catch {
    showNotice("Add failed — the server is not responding.");
    setConn("lost");
    return;
  }
  const body = await readEnvelope(res);
  if (!res.ok) {
    showNotice(body.error ?? `Add failed (HTTP ${res.status}).`);
    return;
  }
  if (body.outcome === "duplicate") {
    showNotice("Already in the queue.");
    return;
  }
  showNotice(
    plan.via === "debrid" && sources?.debridProvider
      ? debridAddedNotice(sources.debridProvider)
      : "Added to the queue.",
  );
}

// ---- preview ----

// The object URL of the poster currently in the pane. Revoked before the next
// one is created: each holds its blob in memory until it is, and a session of
// arrowing through results would otherwise accumulate every poster it loaded.
let posterObjectUrl: string | null = null;

function releasePoster(): void {
  if (posterObjectUrl !== null) {
    URL.revokeObjectURL(posterObjectUrl);
    posterObjectUrl = null;
  }
}

function posterPlaceholder(note: string): void {
  releasePoster();
  const span = document.createElement("span");
  span.className = "poster-note";
  span.textContent = note;
  previewPoster.replaceChildren(span);
}

/**
 * Load a poster through `/api/poster` and show it.
 *
 * Fetched into a blob rather than set as an `<img src>`, for one reason:
 * `/api/poster` is behind the bearer token and an `<img>` cannot send an
 * Authorization header. The alternative was accepting `?k=` on that route the
 * way EventSource forced on `/api/events` — which would put the token in the
 * URL of every poster, i.e. in the server's access log and the browser's
 * history. A fetch keeps it in a header.
 *
 * Every failure ends at the placeholder. A 404 (OMDb named a poster the cache
 * couldn't fetch), a 400 (a host off the allowlist), an offline tab: none of
 * them leave a broken image or a frame that never resolves.
 */
async function loadPoster(url: string, generation: number): Promise<void> {
  try {
    const res = await fetch(posterPath(url), { headers: authHeaders() });
    if (!res.ok) {
      if (generation === previewGeneration) posterPlaceholder("No poster");
      return;
    }
    const blob = await res.blob();
    // The pane moved on while this was in flight; drop it rather than paint a
    // poster over the title the user is now looking at.
    if (generation !== previewGeneration) return;
    releasePoster();
    posterObjectUrl = URL.createObjectURL(blob);
    const img = document.createElement("img");
    img.src = posterObjectUrl;
    img.alt = "";
    previewPoster.replaceChildren(img);
  } catch {
    if (generation === previewGeneration) posterPlaceholder("No poster");
  }
}

// Bumped on every state the pane renders, so an in-flight poster can tell it is
// stale. Separate from previewModel's own staleness check because the poster is
// a second round trip that starts after the metadata has already landed.
let previewGeneration = 0;

function renderPreview(state: PreviewState): void {
  previewGeneration++;
  if (state.kind === "hidden") {
    previewPane.hidden = true;
    posterPlaceholder("");
    return;
  }
  previewPane.hidden = false;
  if (state.kind === "loading") {
    previewTitle.textContent = state.release;
    previewSub.textContent = "";
    previewBody.textContent = "Looking this up…";
    previewImdb.hidden = true;
    posterPlaceholder("Loading");
    return;
  }

  const copy = previewCopy(state.release, state.meta);
  previewTitle.textContent = copy.heading;
  previewSub.textContent = copy.sub;
  previewBody.textContent = copy.body;
  if (copy.imdbUrl) {
    previewImdb.href = copy.imdbUrl;
    previewImdb.hidden = false;
  } else {
    previewImdb.hidden = true;
  }
  if (copy.posterUrl) {
    posterPlaceholder("Loading");
    void loadPoster(copy.posterUrl, previewGeneration);
  } else {
    posterPlaceholder(copy.posterNote);
  }
}

const preview = createPreviewController({
  async fetch(release, group): Promise<PublicTitleMeta | null> {
    const params = new URLSearchParams({ release });
    // The group, not a parsed hint: the server maps it (hintForGroup) so the
    // browser never has to know that "TV" means OMDb's "series".
    if (group && group !== ALL_TAB) params.set("group", group);
    try {
      const res = await fetch(`/api/title?${params.toString()}`, { headers: authHeaders() });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      return body && typeof body === "object" ? (body as PublicTitleMeta) : null;
    } catch {
      return null;
    }
  },
  schedule: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  cancel: (handle) => clearTimeout(handle),
  render: renderPreview,
});

// ---- for you --------------------------------------------------------------
// The feed. Its decisions — lazy first load, refetch on a real filter change,
// the request counter that drops a stale answer, and which event each button
// posts — all live in reccModel.ts. What is here is fetch and DOM.

// Poster object URLs by IMDb id, and the lookups still in flight.
//
// Cached across renders because the list is rebuilt whenever a card is rated
// away, and re-fetching twenty posters for a one-card change would cost twenty
// OMDb lookups against a key with a daily cap. Cleared (and revoked) whenever
// the feed itself is re-fetched, which is the only time the set of picks can
// change underneath it.
/**
 * What one `/api/title?imdb=` lookup learned: the artwork outcome (unchanged
 * shape, `ReccPosterOutcome`) and, as a SIBLING field rather than folded into
 * it, the medium OMDb reported. The two are orthogonal — a title with no
 * poster still has a type — so widening the three-variant poster union to fit
 * the medium in would have made "no poster, but it's a series" inexpressible.
 * `medium` is `null` whenever OMDb was not reached or said nothing (`no-key`,
 * a network failure, or a status other than `"ok"`), never a fresh request:
 * Task 14's Play button reads this same field, it does not ask again.
 */
interface ReccPosterLookup {
  poster: ReccPosterOutcome;
  medium: ReccMedium | null;
}

// Poster object URLs (and medium) by IMDb id, and the lookups still in flight.
//
// Cached across renders because the list is rebuilt whenever a card is rated
// away, and re-fetching twenty posters for a one-card change would cost twenty
// OMDb lookups against a key with a daily cap. Cleared (and revoked) whenever
// the feed itself is re-fetched, which is the only time the set of picks can
// change underneath it.
const reccPosterCache = new Map<string, ReccPosterLookup>();
const reccPosterPending = new Map<string, Promise<ReccPosterLookup>>();

function clearReccPosters(): void {
  for (const { poster } of reccPosterCache.values()) {
    if (poster.kind === "poster") URL.revokeObjectURL(poster.url);
  }
  reccPosterCache.clear();
  reccPosterPending.clear();
  // The note summarises the outcomes just discarded, so it goes with them —
  // otherwise a reload that now finds a key keeps telling you to add one.
  paintReccHint();
}

/**
 * The feed's single "no OMDb key" line, decided by reccPosterHint over every answer
 * so far — not per card, and not by asking the server a second time. Repainted as
 * each lookup settles because one answer is enough to know, and waiting for twenty
 * would leave the frames unexplained meanwhile.
 */
function paintReccHint(): void {
  const hint = reccPosterHint(Array.from(reccPosterCache.values(), (v) => v.poster));
  reccHintLine.textContent = hint ?? "";
  reccHintLine.hidden = hint === null;
}

/**
 * A pick's poster and medium: OMDb by IMDb id, then the bytes through
 * `/api/poster`.
 *
 * Two hops because reccd returns no artwork — only an id — and because the
 * poster must not be fetched from the CDN by the browser directly: an `<img
 * src>` pointing at Amazon leaks the user's IP and referer on every card, which
 * is what `/api/poster` exists to prevent.
 *
 * Every failure still leaves the card a labelled frame rather than a broken image,
 * but WHY it failed is carried out rather than flattened to null: with no OMDb key
 * the server answers `{status:"no-key"}` for all twenty picks, and a reader given
 * twenty bare "No poster" boxes concludes the feature is broken instead of that
 * they are one setting away from artwork.
 *
 * `medium` is read even when there is no poster to show (`PublicTitleMeta.type`
 * on an `"ok"` answer with no `posterUrl`) — it is Task 14's only way to learn
 * whether a For You row is a film, and gating that on artwork existing would
 * silently withhold the Play button from posterless films.
 */
async function fetchReccPoster(imdbId: string): Promise<ReccPosterLookup> {
  try {
    const metaRes = await fetch(`/api/title?imdb=${encodeURIComponent(imdbId)}`, {
      headers: authHeaders(),
    });
    if (!metaRes.ok) return { poster: { kind: "none" }, medium: null };
    const meta = (await metaRes.json()) as PublicTitleMeta;
    if (!meta) return { poster: { kind: "none" }, medium: null };
    if (meta.status === "no-key") return { poster: { kind: "no-key" }, medium: null };
    const medium: ReccMedium | null = meta.status === "ok" ? (meta.type ?? null) : null;
    if (meta.status !== "ok" || !meta.posterUrl) return { poster: { kind: "none" }, medium };
    const posterRes = await fetch(posterPath(meta.posterUrl), { headers: authHeaders() });
    if (!posterRes.ok) return { poster: { kind: "none" }, medium };
    return { poster: { kind: "poster", url: URL.createObjectURL(await posterRes.blob()) }, medium };
  } catch {
    return { poster: { kind: "none" }, medium: null };
  }
}

function paintPosterNote(host: HTMLElement, note: string): void {
  const span = document.createElement("span");
  span.className = "poster-note";
  span.textContent = note;
  host.replaceChildren(span);
}

function paintReccPoster(host: HTMLElement, outcome: ReccPosterOutcome): void {
  if (outcome.kind !== "poster") {
    // The wording is the model's: "No OMDb key" for the config gap, "No poster"
    // for a title that simply has none.
    paintPosterNote(host, reccPosterNote(outcome));
    return;
  }
  const img = document.createElement("img");
  img.src = outcome.url;
  img.alt = "";
  host.replaceChildren(img);
}

function mountReccPoster(imdbId: string, host: HTMLElement): void {
  const cached = reccPosterCache.get(imdbId);
  if (cached !== undefined) {
    paintReccPoster(host, cached.poster);
    return;
  }
  paintPosterNote(host, "Loading");
  let inflight = reccPosterPending.get(imdbId);
  if (!inflight) {
    inflight = fetchReccPoster(imdbId).then((outcome) => {
      reccPosterPending.delete(imdbId);
      // A feed reload between the request and its answer clears the cache; the
      // URL created for a pick nobody is showing any more is revoked rather
      // than leaked back into an empty map. The outcome is dropped with it, so a
      // late answer cannot resurrect the note over a feed that has moved on.
      if (reccPosterCache.size === 0 && reccPosterPending.size === 0) {
        if (outcome.poster.kind === "poster") URL.revokeObjectURL(outcome.poster.url);
        return { poster: { kind: "none" }, medium: null } as ReccPosterLookup;
      }
      reccPosterCache.set(imdbId, outcome);
      paintReccHint();
      return outcome;
    });
    reccPosterPending.set(imdbId, inflight);
  }
  void inflight.then((outcome) => {
    // The card this was for may have been rated away or re-rendered while the
    // two round trips were in flight; a detached node is not worth painting.
    if (host.isConnected) paintReccPoster(host, outcome.poster);
  });
}

/**
 * The For You Play button's medium input: whatever this card's poster lookup
 * already learned, synchronously if it has settled, `undefined` if it has not
 * — never a fresh request (see `PickEffects` in pickModel.ts and
 * `autoPlayableFilm`'s own doc comment for why `undefined` is the right
 * "don't know yet" value, distinct from `null`'s "OMDb said nothing").
 */
function mountReccPlay(item: PublicRecommendation, actions: HTMLElement, filter: ReccType): void {
  const cached = reccPosterCache.get(item.imdbId);
  paintReccPlay(actions, item, cached?.medium, filter);
  if (cached !== undefined) return;
  const pending = reccPosterPending.get(item.imdbId);
  if (!pending) return; // a feed reload dropped this lookup before this card asked
  void pending.then((outcome) => {
    // Same guard as mountReccPoster: the card may be gone by the time the two
    // round trips settle.
    if (actions.isConnected) paintReccPlay(actions, item, outcome.medium, filter);
  });
}

// The whole decision is `autoPlayableFilm` (pickModel.ts, re-exporting
// util/autoPlayableFilm.ts) — this function only looks up its two inputs and
// paints or removes one button. A conditional here that decided WHAT to show
// would be the thing review has caught twice in this codebase.
function paintReccPlay(
  actions: HTMLElement,
  item: PublicRecommendation,
  medium: ReccMedium | null | undefined,
  filter: ReccType,
): void {
  actions.querySelector<HTMLButtonElement>(".recc-play")?.remove();
  if (!autoPlayableFilm(medium, filter)) return;
  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "play recc-play";
  playButton.textContent = "Play";
  playButton.addEventListener("click", () => pickController.start(item.title, { kind: "film" }));
  actions.prepend(playButton);
}

/** Post one rating to reccd and, for the three that are verdicts, drop the pick. */
async function actOnPick(action: ReccAction, item: PublicRecommendation): Promise<void> {
  // The local action never reaches reccd.
  if (!isRatingAction(action)) {
    const title = titleToSave(item);
    if (!title) {
      showNotice(saveSearchBlockedNotice());
      return;
    }
    await toggleSavedSearch(title);
    return;
  }
  // Optimistic, exactly as the TUI is: the event is fire-and-forget on both
  // sides of the wire, so there is nothing to wait for before the card goes.
  if (dismissesPick(action)) recc.dismiss(item.imdbId);
  let res: Response;
  try {
    res = await fetch("/api/recc-event", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(reccEventBody(action, item)),
    });
  } catch {
    showNotice("That didn't reach the server.");
    setConn("lost");
    return;
  }
  if (!res.ok) {
    const body = await readEnvelope(res);
    showNotice(body.error ?? `That didn't stick (HTTP ${res.status}).`);
    return;
  }
  const body = await readJson(res);
  if (body.status === "not-configured") {
    showNotice("Recommendations aren't set up, so that wasn't recorded.");
    return;
  }
  showNotice(actionNotice(action, item));
}

/**
 * Hand a title over to the search pane — the escape hatch every list ties
 * into: a saved query, a For You pick (`searchForPick`, below), and a
 * Continue Watching row's unconditional `search` button both land here.
 * `group`, when given, switches the category tab first; a Continue Watching
 * row has no type filter to map, so it is omitted and the current tab stands.
 */
function searchForTitle(title: string, group?: string): void {
  if (group !== undefined) {
    searchView = { ...searchView, group };
    renderTabs();
  }
  queryInput.value = title;
  showView("search");
  startSearch(title);
}

/** Hand a pick to the search pane — the feed's way out into the rest of the app. */
function searchForPick(item: PublicRecommendation): void {
  // A blank title from reccd must not fall through to browse mode: an empty
  // submit is a deliberate user gesture, and silently answering a pick with
  // the top-100 list would look like a working search for the wrong thing.
  const title = item.title.trim();
  if (!title) {
    showNotice("That pick has no title to search for.");
    return;
  }
  const group = searchGroupForType(recc.state().filters.type, sources);
  searchForTitle(title, group);
}

// Same createElement/textContent rule as every other list on this page, and for
// the same reason: a title and a "because you liked …" line are strings from a
// remote service this app does not control.
function renderPick(item: PublicRecommendation, filter: ReccType): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row recc-card";

  // The poster is a button: it is the card's primary target, and what it does
  // is the TUI's Enter — search for this pick.
  const posterButton = document.createElement("button");
  posterButton.type = "button";
  posterButton.className = "recc-poster";
  posterButton.title = `Search for ${item.title}`;
  const posterFrame = document.createElement("div");
  posterFrame.className = "poster";
  posterButton.append(posterFrame);
  posterButton.addEventListener("click", () => searchForPick(item));
  mountReccPoster(item.imdbId, posterFrame);

  const title = document.createElement("p");
  title.className = "recc-title";
  title.textContent = item.title;
  title.title = item.title;

  const sub = document.createElement("p");
  sub.className = "recc-sub";
  sub.textContent = pickSub(item);

  li.append(posterButton, title, sub);

  const reason = reasonLine(item);
  if (reason) {
    const why = document.createElement("p");
    why.className = "recc-reason";
    why.textContent = reason;
    // Every reason, not just the strongest. An attribute, not markup.
    why.title = reasonTitle(item);
    li.append(why);
  }

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const searchButton = document.createElement("button");
  searchButton.type = "button";
  searchButton.className = "play";
  searchButton.textContent = "search";
  searchButton.addEventListener("click", () => searchForPick(item));
  actions.append(searchButton);

  for (const action of RECC_ACTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = ACTION_LABEL[action];
    button.addEventListener("click", () => void actOnPick(action, item));
    actions.append(button);
  }

  li.append(actions);
  // After the card is fully built: mountReccPlay may re-paint `actions`
  // asynchronously once the poster lookup settles, and it does that with a
  // querySelector/prepend, not by returning a new node — so `actions` has to
  // be the one this li actually holds.
  mountReccPlay(item, actions, filter);
  return li;
}

function renderRecc(state: ReccState): void {
  const items = reccItems(state);
  reccList.replaceChildren(...items.map((item) => renderPick(item, state.filters.type)));

  const status = reccStatus(state);
  reccStatusLine.textContent = status.text;
  reccStatusLine.classList.toggle("error", status.tone === "error");
  reccStatusLine.hidden = !status.show;

  // The controls are meaningless with nothing behind them, and a genre box over
  // an unconfigured reccd is an invitation to a second nothing.
  const usable = state.phase.kind !== "not-configured";
  reccTypeSelect.disabled = !usable;
  reccGenreInput.disabled = !usable;
  reccExploreCheck.disabled = !usable;
  reccRefreshButton.disabled = !usable;
}

const recc = createReccController({
  async fetch(filters): Promise<PublicRecommendations | null> {
    // A new feed means a new set of picks; the posters cached for the old one
    // are released here rather than accumulating a blob per pick per refresh.
    clearReccPosters();
    try {
      const res = await fetch(recommendationsUrl(filters), { headers: authHeaders() });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      return body && typeof body === "object" ? (body as PublicRecommendations) : null;
    } catch {
      return null;
    }
  },
  render: renderRecc,
});

reccTypeSelect.addEventListener("change", () => {
  // The select's values are the model's own type names, so no mapping here —
  // and an unexpected value would be the bug rather than something to paper
  // over with a fallback.
  recc.setType(reccTypeSelect.value as ReccType);
});

// `change`, not `input`: each edit is a request to reccd, so the box commits on
// Enter or blur the way the TUI's genre prompt commits on submit. A per-keystroke
// refetch would be five requests to type "drama".
reccGenreInput.addEventListener("change", () => recc.setGenre(reccGenreInput.value));
reccExploreCheck.addEventListener("change", () => recc.setExplore(reccExploreCheck.checked));
reccRefreshButton.addEventListener("click", () => recc.refresh());

// ---- saved ------------------------------------------------------------
// Saved searches and the library. Decisions — which body each button sends, what
// an empty or broken list says — are savedModel.ts's; what is here is fetch and
// DOM.

let savedState: SavedState = emptySaved();

async function loadSaved(): Promise<void> {
  try {
    const res = await fetch("/api/saved", { headers: authHeaders() });
    if (!res.ok) {
      savedState = { ...savedState, loaded: true, error: `Couldn't load your lists (HTTP ${res.status}).` };
      renderSaved();
      return;
    }
    savedState = applySaved(savedState, await readJson(res));
  } catch {
    savedState = { ...savedState, loaded: true, error: "Couldn't load your lists — the server is not responding." };
  }
  renderSaved();
}

// Both mutators post, then render the list the SERVER returned rather than a
// list predicted here — applySavedSearchesResponse/applyLibraryResponse own that
// fold, and savedSearchesToggleNotice/libraryToggleNotice own the notice text, both
// in savedModel.ts where they can be unit-tested against a malformed body.
async function postSaved(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    showNotice("That didn't reach the server.");
    setConn("lost");
    return null;
  }
  if (!res.ok) {
    const envelope = await readEnvelope(res);
    showNotice(envelope.error ?? `That didn't stick (HTTP ${res.status}).`);
    return null;
  }
  return readJson(res);
}

// Called by the save-search button beside the search box.
async function toggleSavedSearch(query: string): Promise<void> {
  const body = await postSaved("/api/saved-searches", savedSearchesBody(query, "toggle"));
  if (!body) return;
  savedState = applySavedSearchesResponse(savedState, body);
  showNotice(savedSearchesToggleNotice(body));
  renderSaved();
}

async function removeSavedSearch(query: string): Promise<void> {
  const body = await postSaved("/api/saved-searches", savedSearchesBody(query, "remove"));
  if (!body) return;
  savedState = applySavedSearchesResponse(savedState, body);
  renderSaved();
}

// Called by the favourite button on each search row.
async function toggleLibrary(input: LibraryInput): Promise<void> {
  const body = await postSaved("/api/library", libraryBody(input, "toggle"));
  if (!body) return;
  savedState = applyLibraryResponse(savedState, body);
  showNotice(libraryToggleNotice(body));
  renderSaved();
  // The ★ on the matching search row has to agree with what just happened.
  renderResults();
}

async function removeFromLibrary(infoHash: string, name: string): Promise<void> {
  const body = await postSaved("/api/library", libraryBody({ infoHash, name }, "remove"));
  if (!body) return;
  savedState = applyLibraryResponse(savedState, body);
  renderSaved();
  renderResults();
}

async function removeContinueWatching(key: string): Promise<void> {
  const body = await postSaved("/api/continue-watching", continueWatchingBody(key));
  if (!body) return;
  savedState = applyContinueWatchingResponse(savedState, body);
  renderSaved();
}

// Play the remembered torrent; if it will not resolve (a dead swarm, most
// often), fall back to a search rather than leaving the user at a notice and
// nothing else to do. continueWatchingFallbackQuery (savedModel.ts) is the
// decision of WHAT to search for; this is only the DOM effect of switching to
// it, the same shape renderSavedSearchRow's click handler already uses.
async function playContinueWatching(item: PublicStreamHistoryItem): Promise<void> {
  // The at-most-once guarantee is runPlay's (see streamFlow.ts's PlayEffects
  // doc comment) — this is only the DOM effect of switching to a search, the
  // same shape renderSavedSearchRow's click handler already uses.
  // item.next is the server's own nextEpisode over this row's high-water mark —
  // the same value continueWatchingSub renders — so the picker opens on the
  // episode the row promised. Null (a film, a pack with no episode number) simply
  // means no preselection.
  await play(dashRowForPlay(item.infoHash, item.rawName), () => {
    const query = continueWatchingFallbackQuery(item);
    queryInput.value = query;
    showView("search");
    startSearch(query);
  }, item.next);
}

// createElement + textContent, as everywhere else on this page. A saved query is
// the user's own typing, but a favourite's name is a release name from whoever
// uploaded the torrent — so this list is as much an XSS surface as the results
// list is.
function renderSavedSearchRow(query: string): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row";

  const run = document.createElement("button");
  run.type = "button";
  run.className = "saved-query";
  run.textContent = query;
  run.title = `Search for ${query}`;
  run.addEventListener("click", () => {
    queryInput.value = query;
    showView("search");
    startSearch(query);
  });

  const actions = document.createElement("div");
  actions.className = "row-actions";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "remove";
  remove.addEventListener("click", () => void removeSavedSearch(query));
  actions.append(remove);

  li.append(run, actions);
  return li;
}

function renderLibraryRow(f: PublicFavourite): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row";

  const head = document.createElement("div");
  head.className = "result-head";
  const name = document.createElement("span");
  name.className = "row-name";
  name.textContent = f.name;
  name.title = f.name;
  head.append(name);

  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = favouriteMeta(f);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  // Play, through the same play() every other Play button on this page calls
  // (which itself calls runPlay). A favourite has no magnet on the wire and
  // does not need one: POST /api/stream
  // rebuilds it from the hash, exactly as it does for a search hit.
  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "play";
  playButton.textContent = "play";
  playButton.addEventListener("click", () => void play(dashRowForPlay(f.id, f.name)));
  actions.append(playButton);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "remove";
  remove.addEventListener("click", () => void removeFromLibrary(f.id, f.name));
  actions.append(remove);

  li.append(head, meta, actions);
  return li;
}

// createElement + textContent throughout: `title` and `rawName` both come from
// a release name written by whoever uploaded the torrent, the same stranger's
// string `renderLibraryRow`'s `name` is.
function renderContinueRow(item: PublicStreamHistoryItem): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row";

  const head = document.createElement("div");
  head.className = "result-head";
  const name = document.createElement("span");
  name.className = "row-name";
  name.textContent = item.title;
  name.title = item.rawName;
  head.append(name);

  const meta = document.createElement("span");
  meta.className = "row-meta";
  // Read at render time, not cached at module load, so the age is always
  // relative to now rather than to whenever the page happened to start.
  meta.textContent = continueWatchingSub(item, Date.now());

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "play";
  playButton.textContent = "play";
  playButton.addEventListener("click", () => void playContinueWatching(item));
  actions.append(playButton);

  // Unconditional, exactly like the For You card's own `search` button and
  // the terminal's `s` key on both panes (ForYou.tsx and
  // ContinueWatching.tsx): a way to see the other releases for this title
  // without resuming or auto-playing. item.title is not a decision — it is
  // simply what this row is — so there is nothing for pickModel.ts to own
  // here.
  const searchButton = document.createElement("button");
  searchButton.type = "button";
  searchButton.className = "play";
  searchButton.textContent = "search";
  searchButton.addEventListener("click", () => searchForTitle(item.title));
  actions.append(searchButton);

  // Null intent means a film or a season pack: there is no honest next
  // episode (intentForHistoryRow, pickModel.ts), so no Play-next button and
  // the resume action above stands alone.
  const intent = intentForHistoryRow(item);
  if (intent) {
    const playNext = document.createElement("button");
    playNext.type = "button";
    playNext.className = "play";
    playNext.textContent = "Play next";
    // onNone falls back to the same "remembered torrent" resume the plain
    // play button above uses — a fresh pick found nothing, not a reason to
    // strand the row with no action at all.
    playNext.addEventListener("click", () =>
      pickController.start(item.title, intent, () => void playContinueWatching(item)),
    );
    actions.prepend(playNext);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "remove";
  remove.addEventListener("click", () => void removeContinueWatching(item.key));
  actions.append(remove);

  li.append(head, meta, actions);
  return li;
}

function renderSaved(): void {
  continueRows.replaceChildren(...savedState.continueWatching.map(renderContinueRow));
  savedSearchesRows.replaceChildren(...savedState.savedSearches.map(renderSavedSearchRow));
  libraryRows.replaceChildren(...savedState.library.map(renderLibraryRow));

  const cw = continueWatchingStatus(savedState);
  continueStatusLine.textContent = cw.text;
  continueStatusLine.classList.toggle("error", cw.tone === "error");
  continueStatusLine.hidden = !cw.show;

  const wl = savedSearchesStatus(savedState);
  savedSearchesStatusLine.textContent = wl.text;
  savedSearchesStatusLine.classList.toggle("error", wl.tone === "error");
  savedSearchesStatusLine.hidden = !wl.show;

  const lib = libraryStatus(savedState);
  libraryStatusLine.textContent = lib.text;
  libraryStatusLine.classList.toggle("error", lib.tone === "error");
  libraryStatusLine.hidden = !lib.show;
}

// ---- connection -----------------------------------------------------------

// One probe of the JSON API, which — unlike EventSource — reports why it failed.
// Used for the initial unlock, for the auth form, and to explain a dropped
// stream.
type Probe =
  | { state: "ok"; payload: StatusPayload }
  | { state: "unauthorized" }
  | { state: "failed"; detail: string };

async function probe(): Promise<Probe> {
  let res: Response;
  try {
    res = await fetch("/api/status", { headers: authHeaders() });
  } catch {
    // fetch rejects only on a transport failure: nothing listening, DNS, TLS,
    // or the tab going offline. A status code is never an error here.
    return { state: "failed", detail: "no response" };
  }
  if (res.status === 401) return { state: "unauthorized" };
  if (!res.ok) return { state: "failed", detail: `HTTP ${res.status}` };
  try {
    return { state: "ok", payload: (await res.json()) as StatusPayload };
  } catch {
    return { state: "failed", detail: "unreadable response" };
  }
}

function showAuth(message?: string): void {
  app.hidden = true;
  // The pane switch is meaningless with nothing behind it, and leaving it up
  // over the token form invites a click that does nothing visible. The
  // preferences disclosure is the same story, plus a sharper failure mode:
  // touching it before unlocking would fire an unauthenticated POST
  // /api/preferences and get a 401 for its trouble.
  viewsNav.hidden = true;
  prefsBlock.hidden = true;
  authForm.hidden = false;
  if (message === undefined) {
    authError.hidden = true;
  } else {
    authError.textContent = message;
    authError.hidden = false;
  }
  tokenInput.focus();
}

// An unreachable server must not look like a blank page or like a token prompt
// the user cannot satisfy. Show the shell with an honest explanation in place of
// the empty-queue line.
function showUnreachable(detail: string): void {
  setConn("lost");
  authForm.hidden = true;
  app.hidden = false;
  viewsNav.hidden = false;
  prefsBlock.hidden = false;
  // On the queue pane, because that is where the explanation goes — a search
  // box over an unreachable server is an invitation to a second failure.
  showView("queue");
  rows = [];
  render();
  emptyNote.textContent = `Can't reach torlnk (${detail}). Check it is still running, then reload.`;
  emptyNote.classList.add("error");
  emptyNote.hidden = false;
}

function openApp(payload: StatusPayload): void {
  authForm.hidden = true;
  authError.hidden = true;
  app.hidden = false;
  viewsNav.hidden = false;
  prefsBlock.hidden = false;
  showView(view);
  renderTabs();
  layoutSelect.value = layout;
  renderResults();
  renderSaved();
  renderPrefs();
  rows = mergeRows(rows, rowsFromStatus(payload));
  render();
  connect();
  // After the panes are on screen: the tab strip and the source badges improve
  // when it lands, and nothing waits on it.
  void loadSources();
  // Ahead of any search, because renderResult labels its favourite button from
  // savedState: without this, a hit already in the library opens reading
  // "favourite" and the first click removes it.
  void loadSaved();
  queryInput.focus();
}

function connect(): void {
  stream?.close();
  // EventSource cannot send headers, so a token-protected server takes the
  // token from the query string here. It grants read-only status access.
  const url = token ? `/api/events?k=${encodeURIComponent(token)}` : "/api/events";
  const source = new EventSource(url);
  stream = source;
  setConn("connecting");
  source.addEventListener("open", () => setConn("live"));
  source.addEventListener("status", (event) => {
    setConn("live");
    let payload: StatusPayload;
    try {
      payload = JSON.parse((event as MessageEvent<string>).data) as StatusPayload;
    } catch {
      // A frame we cannot parse is not a reason to drop the whole stream; the
      // next tick is 250ms away.
      return;
    }
    rows = mergeRows(rows, rowsFromStatus(payload));
    render();
  });
  source.addEventListener("error", () => {
    if (source !== stream) return;
    setConn("lost");
    // EventSource retries forever and never says why it failed — a rotated or
    // revoked token is a 401 on every attempt, which would otherwise present as
    // a permanently "lost" badge with no way out. The JSON API does report
    // status, so ask it once per drop and hand the user the auth form if the
    // token is the problem. Anything else is left to EventSource's own retry.
    if (reprobing) return;
    reprobing = true;
    void probe().then((result) => {
      reprobing = false;
      if (result.state !== "unauthorized" || source !== stream) return;
      source.close();
      stream = null;
      showAuth("The server no longer accepts that token.");
    });
  });
}

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  token = tokenInput.value.trim();
  void probe().then((result) => {
    if (result.state === "ok") {
      storeToken(token);
      tokenInput.value = "";
      openApp(result.payload);
    } else if (result.state === "unauthorized") {
      authError.textContent = "That token was rejected.";
      authError.hidden = false;
    } else {
      authError.textContent = `Can't reach torlnk (${result.detail}).`;
      authError.hidden = false;
    }
  });
});

addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const magnet = magnetInput.value.trim();
  if (!magnet) return;
  void (async () => {
    let res: Response;
    try {
      res = await fetch("/api/add", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ magnet }),
      });
    } catch {
      showNotice("Add failed — the server is not responding.");
      setConn("lost");
      return;
    }
    const body = await readEnvelope(res);
    if (res.ok) {
      magnetInput.value = "";
      showNotice(body.outcome === "duplicate" ? "Already in the queue." : "Added.");
      return;
    }
    showNotice(body.error ?? `Add failed (HTTP ${res.status}).`);
  })();
});

// Startup. A tokenless (loopback) server answers /api/status straight away and
// unlocks with no prompt; a 401 means we need one.
void probe().then((result) => {
  if (result.state === "ok") openApp(result.payload);
  else if (result.state === "unauthorized") showAuth();
  else showUnreachable(result.detail);
});
