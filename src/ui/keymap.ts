import type { DownloadFocus, Region, Section, SeedFocus } from "./store";

export interface Hint {
  keys: string;
  label: string;
}

interface HelpGroup {
  title: string;
  hints: Hint[];
}

export const HELP_GROUPS: HelpGroup[] = [
  {
    title: "Navigate",
    hints: [
      { keys: "↑↓←→ / hjkl", label: "Navigate panes and lists" },
      { keys: "↵", label: "Open" },
      { keys: "tab", label: "Switch pane" },
      { keys: "esc", label: "Back" },
      { keys: "o", label: "Default download folder" },
      { keys: "S", label: "Choose sources" },
      { keys: "D", label: "Custom DNS (bypass blocked networks)" },
      { keys: "t", label: "Extra trackers" },
      { keys: "L", label: "Transfer and seeding limits" },
      { keys: "V", label: "VPN kill switch" },
      { keys: "q", label: "Quit" },
    ],
  },
  {
    title: "Accounts",
    hints: [
      { keys: "↑ ↓", label: "Move between services" },
      { keys: "↵", label: "Sign in / switch account" },
      { keys: "x", label: "Sign out" },
    ],
  },
  {
    title: "Search",
    hints: [
      { keys: "/", label: "Edit search" },
      { keys: "↵", label: "Run search" },
      { keys: "↑", label: "Recall recent searches (while editing)" },
      { keys: "f", label: "Filter list" },
      { keys: "s", label: "Sort results" },
      { keys: "z", label: "Hide results with no seeders" },
      { keys: "w", label: "Save or remove current search" },
      { keys: "d", label: "Download (P2P)" },
      { keys: "shift+d", label: "Download to a chosen folder" },
      { keys: "r", label: "Download via Real-Debrid" },
      { keys: "v", label: "Stream" },
      { keys: "b", label: "Favourite a video (detail view / stream picker)" },
      { keys: "y", label: "Copy magnet" },
      { keys: "m", label: "Paste magnet" },
      { keys: "x", label: "Stop active stream" },
    ],
  },
  {
    title: "Downloads",
    hints: [
      { keys: "p", label: "Pause/resume" },
      { keys: "c", label: "Cancel or remove (shift+c: all)" },
      { keys: "f", label: "Retry failed" },
      { keys: "d", label: "Download again" },
      { keys: "e", label: "Open folder" },
      { keys: "s", label: "Export torrent file" },
    ],
  },
  {
    title: "Seeding",
    hints: [
      { keys: "p", label: "Pause/resume" },
      { keys: "c", label: "Remove from list" },
      { keys: "e", label: "Open folder" },
    ],
  },
];

// Footer labels stay terse so the contextual hint row never wraps; the `?`
// overlay (HELP_GROUPS) carries the full, descriptive list. Rare or
// self-announcing actions (z) stay `?`-only to keep every row inside 80 cols.
const NAVIGATE: Hint = { keys: "↑↓←→", label: "Move" };

const ALWAYS: Hint = { keys: "?", label: "Keys" };

const SWITCH: Hint = { keys: "tab", label: "Switch" };

const FOLDER: Hint = { keys: "e", label: "Folder" };

const TORRENT: Hint = { keys: "s", label: "Export" };

export function footerHints(
  region: Region,
  section: Section,
  downloadFocus?: DownloadFocus | null,
  seedFocus?: SeedFocus | null,
  debridConfigured = false,
): Hint[] {
  if (region === "sidebar") {
    return [
      NAVIGATE,
      { keys: "↵", label: "Open" },
      SWITCH,
      ALWAYS,
      { keys: "q", label: "Quit" },
    ];
  }
  if (section === "seeding") {
    const label =
      seedFocus === "seeding" ? "Pause" : seedFocus === "missing" ? "Retry" : "Resume";
    return [{ keys: "p", label }, { keys: "c", label: "Remove from list" }, FOLDER, SWITCH, ALWAYS];
  }
  if (section === "accounts") {
    return [
      NAVIGATE,
      { keys: "↵", label: "Sign in" },
      { keys: "x", label: "Sign out" },
      SWITCH,
      ALWAYS,
    ];
  }
  if (section === "watchlist") {
    return [NAVIGATE, { keys: "↵", label: "Run" }, { keys: "x", label: "Remove" }, SWITCH, ALWAYS];
  }
  if (section === "library") {
    return [NAVIGATE, { keys: "↵", label: "Resume" }, { keys: "x", label: "Remove" }, SWITCH, ALWAYS];
  }
  if (section === "downloads") {
    if (downloadFocus === "paused") {
      return [{ keys: "p", label: "Resume" }, { keys: "c", label: "Cancel" }, FOLDER, TORRENT, SWITCH, ALWAYS];
    }
    if (downloadFocus === "failed") {
      return [{ keys: "f", label: "Retry" }, { keys: "c", label: "Remove" }, FOLDER, TORRENT, SWITCH, ALWAYS];
    }
    if (downloadFocus === "recent") {
      // Removal is list bookkeeping, never file deletion, and the label says
      // so. Clear-all (shift+c) stays `?`-only, like D.
      return [
        { keys: "d", label: "Redownload" },
        { keys: "c", label: "Remove from list" },
        FOLDER,
        TORRENT,
        SWITCH,
        ALWAYS,
      ];
    }
    return [
      { keys: "p", label: "Pause" },
      { keys: "c", label: "Cancel" },
      { keys: "y", label: "Link" },
      FOLDER,
      TORRENT,
      SWITCH,
      ALWAYS,
    ];
  }
  return [
    NAVIGATE,
    // The footer advertises only the default download key; D (download to a
    // chosen folder) stays bound but lives in the `?` sheet alone.
    { keys: "d", label: "Download" },
    ...(debridConfigured ? [{ keys: "r", label: "Real-Debrid" }] : []),
    { keys: "v", label: "Stream" },
    { keys: "y", label: "Copy" },
    { keys: "s", label: "Sort" },
    { keys: "z", label: "Alive" },
    { keys: "w", label: "Watch" },
    { keys: "/", label: "Search" },
    { keys: "f", label: "Filter" },
    SWITCH,
    ALWAYS,
  ];
}
