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
  type DashRow,
  type StatusPayload,
} from "./dashboard";

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

// A confirm() dialog on a phone has to stay readable, and a torrent name can be
// several hundred characters of release tags. Clip it for the prompt only — the
// row itself still shows the full name in its title attribute.
function shortName(name: string): string {
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}

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
}

// The server's error envelope. Read defensively: a proxy or a crash can return
// something that is not this shape at all.
interface ApiError {
  error?: string;
  outcome?: string;
}

async function readEnvelope(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as ApiError) : {};
  } catch {
    return {};
  }
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
  rows = mergeRows(rows, rowsFromStatus(payload));
  render();
  connect();
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
