// Pure view state for the browser's settings overlay. Every decision about what
// to show and what to send lives here; `app.ts` is DOM binding only — the same
// split searchModel.ts, savedModel.ts and dashboard.ts use, and for the same
// reason: there is no jsdom in this repo, so pure modules are how this gets
// tested (CLAUDE.md, "Testing the browser UI").
//
// Bundled for the browser: no node:* imports, direct or transitive.
//
// The one import that leaves this directory besides `../wire` (types-only,
// erased at build) is `debridProviderLabel` from searchModel — the provider's
// display name. Reused rather than recopied because a second table of provider
// labels is exactly the copy-then-drift bug this codebase keeps hitting.
import { debridProviderLabel, type WireDebridProvider } from "./searchModel";
import type { PublicWritableSettings, SettingsAccounts, SettingsResponse } from "../wire";

// Re-exported for a single import site in app.ts (matching searchModel), so no
// one redeclares a producer's payload shape in the browser bundle.
export type { PublicWritableSettings, SettingsAccounts, SettingsEnvLocks, SettingsResponse } from "../wire";

export type ToggleKey = "adultContent" | "proxyDebridStreams";
export type NumberKey = "downloadLimitKbps" | "uploadLimitKbps" | "seedRatio" | "seedMinutes";
export type TextKey = "downloadDir" | "mediaPlayer";

// Every control carries `locked`/`lockNote` so app.ts renders the read-only
// state one way for all kinds; only the two env-overridable fields ever set them.
interface ControlBase {
  label: string;
  hint: string;
  locked: boolean;
  lockNote: string | null;
}

/**
 * One control the overlay renders. A discriminated union so app.ts renders each
 * shape with a small switch and never decides copy, values or lock state itself.
 * A `locked` control is rendered read-only with its `lockNote` shown — matching
 * the TUI, which declines the toggle an env var owns.
 */
export type SettingsControl =
  | (ControlBase & { kind: "toggle"; key: ToggleKey; value: boolean })
  | (ControlBase & { kind: "number"; key: NumberKey; value: number | null; unit: string; step: number })
  | (ControlBase & { kind: "text"; key: TextKey; value: string; placeholder: string });

export interface SettingsSection {
  title: string;
  controls: SettingsControl[];
}

const ADULT_LOCK_NOTE = "Set by the TORLINK_ADULT environment variable.";
const PLAYER_LOCK_NOTE = "Set by the TORLINK_PLAYER environment variable.";

/**
 * The scalar controls, grouped into sections, straight from `GET /api/settings`.
 *
 * Quality (the feature picker), the source on/off list, and the read-only
 * Accounts block are rendered by their own code in app.ts — they are lists, not
 * scalars — so they are deliberately NOT here. Everything with a single value is.
 */
export function settingsSections(res: SettingsResponse): SettingsSection[] {
  const s = res.settings;
  const locks = res.envLocks;
  return [
    {
      title: "Content",
      controls: [
        {
          kind: "toggle",
          key: "adultContent",
          label: "Adult content",
          hint: "Show the Porn category and its sources.",
          value: s.adultContent,
          locked: locks.adultContent,
          lockNote: locks.adultContent ? ADULT_LOCK_NOTE : null,
        },
      ],
    },
    {
      title: "Downloads",
      controls: [
        {
          kind: "text",
          key: "downloadDir",
          label: "Download folder",
          hint: "Where finished downloads are saved — a path on the server.",
          value: s.downloadDir,
          placeholder: "/downloads",
          locked: false,
          lockNote: null,
        },
        {
          kind: "text",
          key: "mediaPlayer",
          label: "Media player",
          hint: "Player command for streaming, e.g. mpv. Leave empty to auto-detect.",
          value: s.mediaPlayer,
          placeholder: "auto-detect",
          locked: locks.mediaPlayer,
          lockNote: locks.mediaPlayer ? PLAYER_LOCK_NOTE : null,
        },
        {
          kind: "toggle",
          key: "proxyDebridStreams",
          label: "Relay debrid streams",
          hint: "Stream debrid media through this server instead of redirecting. Uses this machine's upload.",
          value: s.proxyDebridStreams,
          locked: false,
          lockNote: null,
        },
      ],
    },
    {
      title: "Transfer limits",
      controls: [
        {
          kind: "number",
          key: "downloadLimitKbps",
          label: "Download limit",
          hint: "Leave empty for no limit.",
          value: s.downloadLimitKbps,
          unit: "KB/s",
          step: 1,
          locked: false,
          lockNote: null,
        },
        {
          kind: "number",
          key: "uploadLimitKbps",
          label: "Upload limit",
          hint: "Leave empty for no limit.",
          value: s.uploadLimitKbps,
          unit: "KB/s",
          step: 1,
          locked: false,
          lockNote: null,
        },
        {
          kind: "number",
          key: "seedRatio",
          label: "Seed ratio",
          hint: "Stop seeding once uploaded this many times the size. Empty for no ratio limit.",
          value: s.seedRatio,
          unit: "ratio",
          step: 0.1,
          locked: false,
          lockNote: null,
        },
        {
          kind: "number",
          key: "seedMinutes",
          label: "Seed time",
          hint: "Stop seeding after this long. Empty for no time limit.",
          value: s.seedMinutes,
          unit: "minutes",
          step: 1,
          locked: false,
          lockNote: null,
        },
      ],
    },
  ];
}

/** The `settings` patch for flipping a toggle. */
export function togglePatch(key: ToggleKey, current: boolean): Partial<PublicWritableSettings> {
  return { [key]: !current };
}

/**
 * The `settings` patch for a number field's input value.
 *
 * A blank box, or anything that isn't a positive number, means "no limit" and
 * is sent as `null` — the server clears the field. The value is sent as typed
 * (the server floors integer fields); this only decides limit-vs-clear so the
 * two never disagree with what the box shows.
 */
export function numberPatch(key: NumberKey, raw: string): Partial<PublicWritableSettings> {
  const trimmed = raw.trim();
  if (trimmed === "") return { [key]: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return { [key]: null };
  return { [key]: n };
}

/** The `settings` patch for a text field. Trimmed; the server drops a blank downloadDir. */
export function textPatch(key: TextKey, raw: string): Partial<PublicWritableSettings> {
  return { [key]: raw.trim() };
}

/**
 * The `settings` patch for enabling or disabling one source.
 *
 * Computes the whole `disabledSources` list from the current one, because the
 * write replaces the array — the overlay holds the current list (from
 * `/api/settings` or `/api/sources`) and this turns one toggle into the next
 * complete list. Never mutates the input.
 */
export function sourceTogglePatch(
  disabled: readonly string[],
  id: string,
  enabled: boolean,
): Partial<PublicWritableSettings> {
  const set = new Set(disabled);
  if (enabled) set.delete(id);
  else set.add(id);
  return { disabledSources: [...set] };
}

/** One read-only account row for the overlay's Accounts section. */
export interface AccountRow {
  label: string;
  status: string;
  /** True when the account is configured — drives the status tick vs dot. */
  ok: boolean;
}

/**
 * The Accounts section, read-only. Accounts are configured in the terminal (the
 * browser never sees a token, by design), so this reports status and nothing
 * more. Booleans and ids in, prose out — no credential is involved.
 */
export function accountRows(accounts: SettingsAccounts): AccountRow[] {
  const debridLabel = accounts.debridProvider
    ? debridProviderLabel(accounts.debridProvider as WireDebridProvider)
    : "Debrid";
  const reccStatus = accounts.reccConfigured
    ? accounts.reccAccount
      ? `Signed in as ${accounts.reccAccount.name}`
      : "Connected"
    : "Not configured";
  return [
    {
      label: debridLabel,
      status: accounts.debridConfigured ? "Connected" : "Not connected",
      ok: accounts.debridConfigured,
    },
    { label: "OMDb", status: accounts.omdbConfigured ? "Key set" : "Not configured", ok: accounts.omdbConfigured },
    { label: "reccd", status: reccStatus, ok: accounts.reccConfigured },
    // Read-only, like the rest of this section: whether the origin enforces
    // Cloudflare Access. A capability flag — the browser never sees the team
    // domain or AUD, only whether the gate is on.
    {
      label: "Cloudflare Access",
      status: accounts.cloudflareAccessEnforced ? "Enforced" : "Not configured",
      ok: accounts.cloudflareAccessEnforced,
    },
  ];
}

/** The line under the Accounts heading — accounts are managed in the terminal. */
export const ACCOUNTS_HINT =
  "Accounts are signed in from the terminal UI — the browser shows their status here.";
