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
  playerPath,
  runPlay,
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
  categoryTabs,
  emptyView,
  parseSort,
  previewApplies,
  reportsHealthLookup,
  resultMeta,
  rowForPlay,
  searchStatus,
  searchUrl,
  sourceLabel,
  statusLineHidden,
  visibleResults,
  type AddVia,
  type PublicSearchResult,
  type PublicSearchSnapshot,
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
  ACTION_LABEL,
  createReccController,
  dismissesPick,
  actionNotice,
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
  searchGroupForType,
  type PublicRecommendation,
  type PublicRecommendations,
  type ReccAction,
  type ReccPosterOutcome,
  type ReccState,
  type ReccType,
} from "./reccModel";

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

const viewsNav = el<HTMLElement>("views");
const viewSearchTab = el<HTMLButtonElement>("view-search");
const viewReccTab = el<HTMLButtonElement>("view-recc");
const viewQueueTab = el<HTMLButtonElement>("view-queue");
const queueCount = el<HTMLSpanElement>("queue-count");
const paneSearch = el<HTMLElement>("pane-search");
const paneRecc = el<HTMLElement>("pane-recc");
const paneQueue = el<HTMLElement>("pane-queue");

const reccTypeSelect = el<HTMLSelectElement>("recc-type");
const reccGenreInput = el<HTMLInputElement>("recc-genre");
const reccExploreCheck = el<HTMLInputElement>("recc-explore");
const reccRefreshButton = el<HTMLButtonElement>("recc-refresh");
const reccStatusLine = el<HTMLParagraphElement>("recc-status");
const reccHintLine = el<HTMLParagraphElement>("recc-hint");
const reccList = el<HTMLUListElement>("recc-list");

const searchForm = el<HTMLFormElement>("search");
const queryInput = el<HTMLInputElement>("query");
const tabsBar = el<HTMLDivElement>("tabs");
const sortSelect = el<HTMLSelectElement>("sort");
const filterInput = el<HTMLInputElement>("filter");
const aliveCheck = el<HTMLInputElement>("alive");
const searchProgress = el<HTMLSpanElement>("search-progress");
const searchStatusLine = el<HTMLParagraphElement>("search-status");
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
  picker.hidden = true;
  pickerFiles.replaceChildren();
}

// Same createElement/textContent rule as renderRow, and for a stronger reason:
// these strings are filenames from inside a stranger's torrent.
function showPicker(
  sessionId: string,
  capability: string,
  name: string,
  files: PublicStreamFile[],
): void {
  pickerSession = sessionId;
  pickerTitle.textContent = `Which file from “${shortName(name)}”?`;
  pickerFiles.replaceChildren(
    ...files.map((file) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "picker-file";
      button.textContent = fileLabel(file);
      button.title = file.filename;
      button.addEventListener("click", () => {
        // hidePicker() clears pickerSession, so the Cancel handler can no longer
        // stop the session we are about to hand to the player.
        hidePicker();
        openPlayer(playerPath(sessionId, file, capability));
      });
      li.append(button);
      return li;
    }),
  );
  picker.hidden = false;
}

pickerCancel.addEventListener("click", () => {
  const sessionId = pickerSession;
  hidePicker();
  if (sessionId) stopSession(sessionId);
});

// The flow itself is runPlay in streamFlow.ts, where a unit test can reach it —
// including the two rules that matter, the torrent-confirm prompt and the
// keep-polling-while-resolving loop. Everything bound here is an effect:
//
// `confirm` is the native dialog, deliberately, for the same reason the delete
// gate uses it. Synchronous and unmissable are the right properties for a
// decision whose consequence (your IP in a public swarm) cannot be taken back.
async function play(row: DashRow): Promise<void> {
  if (playing.has(row.id)) return;
  playing.add(row.id);
  try {
    await runPlay(row, {
      start: startSession,
      poll: pollSession,
      stop: stopSession,
      confirm: (message) => confirm(message),
      notice: showNotice,
      choose: showPicker,
      open: (path) => openPlayer(path),
      sleep,
      now: () => Date.now(),
    });
  } finally {
    playing.delete(row.id);
  }
}

// ---- search ---------------------------------------------------------------
// Everything to the next banner is the search pane. As with Play, the decisions
// live in pure modules — searchModel.ts and previewModel.ts — and what is here
// is EventSource, fetch and DOM.

// Search opens first. This app is a torrent finder; a queue monitor is what it
// looks like when it opens on the queue. The Queue tab carries a count so
// nothing in flight is out of sight.
type ViewName = "search" | "recc" | "queue";
let view: ViewName = "search";

let searchView: SearchView = emptyView();
let sources: SourcesResponse | null = null;
let searchStream: EventSource | null = null;
// The info hash of the row whose preview is showing, so a re-render can restore
// the selection: the results list is rebuilt on every snapshot frame, and up to
// 23 of those arrive during one search.
let selectedHash: string | null = null;

function showView(next: ViewName): void {
  view = next;
  paneSearch.hidden = next !== "search";
  paneRecc.hidden = next !== "recc";
  paneQueue.hidden = next !== "queue";
  viewSearchTab.setAttribute("aria-pressed", String(next === "search"));
  viewReccTab.setAttribute("aria-pressed", String(next === "recc"));
  viewQueueTab.setAttribute("aria-pressed", String(next === "queue"));
  // The feed's first load happens here and nowhere else — `open()` is a no-op
  // after the first call, so this is "the tab has been visited", not "fetch
  // again". Nothing asks reccd for anything until a human opens this pane.
  if (next === "recc") recc.open();
}

viewSearchTab.addEventListener("click", () => showView("search"));
viewReccTab.addEventListener("click", () => showView("recc"));
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
        if (searchView.group === group) return;
        searchView = { ...searchView, group };
        renderTabs();
        // Switching category re-runs the search rather than filtering what is
        // already here: the server searches only that group's sources, so the
        // other tabs' hits were never fetched. Matches the TUI, where each tab
        // is its own slice of one fan-out.
        // `mode`, not `query`: a browse has an empty query but absolutely needs
        // re-running, because the server only fetched the old tab's sources.
        if (searchView.mode === "idle") renderResults();
        else startSearch(searchView.query);
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
  } catch {
    // A tab strip we cannot build is survivable — "All" still searches
    // everything, and the source badges fall back to raw ids. Failing the whole
    // page for it would not be.
    return;
  }
  renderTabs();
  renderResults();
}

function stopSearch(): void {
  searchStream?.close();
  searchStream = null;
}

function startSearch(query: string): void {
  stopSearch();
  // An empty query is browse mode, not a mistake — the server accepts it and
  // every source answers with its own top/latest list. See parseSearchParams.
  const mode = query ? "search" : "browse";
  searchView = { ...searchView, query, mode, snapshot: null, running: true };
  selectedHash = null;
  preview.select(null, searchView.group);
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

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  // No guard on an empty value: submitting a blank box is how you browse the
  // top lists, the same as pressing Enter on an empty box in the TUI.
  startSearch(queryInput.value.trim());
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

  // Offered only where the TUI offers `r`: when a Real-Debrid token is actually
  // configured. A button that always answered "set a token first" is noise.
  if (sources?.debridConfigured) {
    const debridButton = document.createElement("button");
    debridButton.type = "button";
    debridButton.textContent = "add via RD";
    debridButton.addEventListener("click", () => void addResult(result, "debrid"));
    actions.append(debridButton);
  }

  li.append(head, meta, actions);
  return li;
}

function renderResults(): void {
  const shown = visibleResults(searchView, reportsHealthLookup(sources));
  resultsList.replaceChildren(...shown.map(renderResult));

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
  const plan = addPlan(via, sources?.debridConfigured === true, result.name);
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
  showNotice(plan.via === "debrid" ? "Added via Real-Debrid." : "Added to the queue.");
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
const reccPosterCache = new Map<string, ReccPosterOutcome>();
const reccPosterPending = new Map<string, Promise<ReccPosterOutcome>>();

function clearReccPosters(): void {
  for (const outcome of reccPosterCache.values()) {
    if (outcome.kind === "poster") URL.revokeObjectURL(outcome.url);
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
  const hint = reccPosterHint(reccPosterCache.values());
  reccHintLine.textContent = hint ?? "";
  reccHintLine.hidden = hint === null;
}

/**
 * A pick's poster: OMDb by IMDb id, then the bytes through `/api/poster`.
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
 */
async function fetchReccPoster(imdbId: string): Promise<ReccPosterOutcome> {
  try {
    const metaRes = await fetch(`/api/title?imdb=${encodeURIComponent(imdbId)}`, {
      headers: authHeaders(),
    });
    if (!metaRes.ok) return { kind: "none" };
    const meta = (await metaRes.json()) as PublicTitleMeta;
    if (!meta) return { kind: "none" };
    if (meta.status === "no-key") return { kind: "no-key" };
    if (meta.status !== "ok" || !meta.posterUrl) return { kind: "none" };
    const posterRes = await fetch(posterPath(meta.posterUrl), { headers: authHeaders() });
    if (!posterRes.ok) return { kind: "none" };
    return { kind: "poster", url: URL.createObjectURL(await posterRes.blob()) };
  } catch {
    return { kind: "none" };
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
    paintReccPoster(host, cached);
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
        if (outcome.kind === "poster") URL.revokeObjectURL(outcome.url);
        return { kind: "none" };
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
    if (host.isConnected) paintReccPoster(host, outcome);
  });
}

/** Post one rating to reccd and, for the three that are verdicts, drop the pick. */
async function actOnPick(action: ReccAction, item: PublicRecommendation): Promise<void> {
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

/** Hand a pick to the search pane — the feed's way out into the rest of the app. */
function searchForPick(item: PublicRecommendation): void {
  const group = searchGroupForType(recc.state().filters.type, sources);
  searchView = { ...searchView, group };
  renderTabs();
  queryInput.value = item.title;
  showView("search");
  startSearch(item.title);
}

// Same createElement/textContent rule as every other list on this page, and for
// the same reason: a title and a "because you liked …" line are strings from a
// remote service this app does not control.
function renderPick(item: PublicRecommendation): HTMLLIElement {
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
  return li;
}

function renderRecc(state: ReccState): void {
  const items = reccItems(state);
  reccList.replaceChildren(...items.map(renderPick));

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
  // over the token form invites a click that does nothing visible.
  viewsNav.hidden = true;
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
  showView(view);
  renderTabs();
  renderResults();
  rows = mergeRows(rows, rowsFromStatus(payload));
  render();
  connect();
  // After the panes are on screen: the tab strip and the source badges improve
  // when it lands, and nothing waits on it.
  void loadSources();
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
