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
      { keys: "P", label: "Playback quality (resolution and features)" },
      { keys: "D", label: "Custom DNS (bypass blocked networks)" },
      { keys: "t", label: "Extra trackers" },
      { keys: "L", label: "Transfer and seeding limits" },
      { keys: "V", label: "VPN kill switch" },
      { keys: "N", label: "Relay debrid streams through this machine" },
      { keys: "shift+w", label: "Open the web UI in a browser (needs --web)" },
      { keys: "shift+x", label: "Toggle adult content (Porn category)" },
      { keys: "q", label: "Quit" },
    ],
  },
  {
    title: "Accounts",
    hints: [
      { keys: "↑ ↓", label: "Move between services" },
      { keys: "↵", label: "Sign in / switch account" },
      { keys: "x", label: "Sign out" },
      { keys: "i", label: "Import history — Netflix or Trakt (reccd)" },
      { keys: "a", label: "Make the highlighted debrid provider active" },
    ],
  },
  {
    title: "Search",
    hints: [
      { keys: "/", label: "Edit search" },
      { keys: "↵", label: "Run search" },
      { keys: "↑", label: "Recall recent searches (while editing)" },
      { keys: "i", label: "Open on IMDb (exact match, or a title search)" },
      { keys: "f", label: "Filter list" },
      { keys: "p", label: "Toggle poster / plot preview (needs OMDb key)" },
      { keys: "s", label: "Sort results" },
      { keys: "z", label: "Hide results with no seeders" },
      { keys: "g", label: "Group many releases of one title (on by default)" },
      { keys: "space", label: "Expand or collapse the group under the cursor" },
      { keys: "w", label: "Save or remove current search" },
      { keys: "d", label: "Download (P2P)" },
      { keys: "shift+d", label: "Download to a chosen folder" },
      { keys: "r", label: "Download via debrid (Real-Debrid / TorBox)" },
      { keys: "v", label: "Stream" },
      { keys: "b", label: "Favourite a video (detail view / stream picker)" },
      { keys: "y", label: "Copy magnet" },
      { keys: "m", label: "Paste magnet" },
      { keys: "x", label: "Stop active stream" },
    ],
  },
  {
    title: "For You",
    hints: [
      { keys: "↑ ↓", label: "Move between picks" },
      { keys: "↵", label: "Play the best release (confirmed films) / otherwise search the title" },
      { keys: "s", label: "Search this title instead of playing it" },
      { keys: "i", label: "Open the IMDb page" },
      { keys: "p", label: "Toggle poster / plot preview (needs OMDb key)" },
      { keys: "t", label: "Cycle movie / TV / all" },
      { keys: "g", label: "Filter by genre" },
      { keys: "e", label: "Toggle explore mode" },
      { keys: "b", label: "Show / hide the 'why' reasons" },
      { keys: "f", label: "Rate — watched / like / dislike" },
      { keys: "w", label: "Save this title as a search" },
      { keys: "r", label: "Refresh recommendations" },
    ],
  },
  {
    title: "Continue watching",
    hints: [
      { keys: "↑ ↓", label: "Move between titles" },
      { keys: "↵", label: "Play the next episode, or resume where there is none" },
      { keys: "r", label: "Resume the remembered torrent" },
      { keys: "s", label: "Search this title instead of playing it" },
      { keys: "x", label: "Remove from the list" },
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
  debridLabel?: string,
  streamActive = false,
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
      { keys: "i", label: "Import" },
      { keys: "a", label: "Use" },
      SWITCH,
      ALWAYS,
    ];
  }
  // The three list panes all reserve "x" for stopping a live stream (App.tsx
  // intercepts it; ContinueWatching/SavedSearches/Favourites skip their own
  // handler while one runs), so advertising "Remove" then would promise
  // something the next keypress will not do.
  const REMOVE: Hint = streamActive
    ? { keys: "x", label: "Stop stream" }
    : { keys: "x", label: "Remove" };
  if (section === "continueWatching") {
    return [
      NAVIGATE,
      { keys: "↵", label: "Play" },
      { keys: "r", label: "Resume" },
      { keys: "s", label: "Search" },
      REMOVE,
      SWITCH,
      ALWAYS,
    ];
  }
  if (section === "savedSearches") {
    return [NAVIGATE, { keys: "↵", label: "Run" }, REMOVE, SWITCH, ALWAYS];
  }
  if (section === "library") {
    return [NAVIGATE, { keys: "↵", label: "Resume" }, REMOVE, SWITCH, ALWAYS];
  }
  if (section === "forYou") {
    return [
      NAVIGATE,
      { keys: "↵", label: "Play" },
      { keys: "s", label: "Search" },
      { keys: "i", label: "IMDb" },
      { keys: "f", label: "Rate" },
      { keys: "w", label: "Watch" },
      { keys: "t", label: "Type" },
      { keys: "g", label: "Genre" },
      { keys: "e", label: "Explore" },
      { keys: "r", label: "Refresh" },
      SWITCH,
      ALWAYS,
    ];
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
    // EARLY, and measured. This row is 115 columns bare and 131 with
    // Real-Debrid configured, so Footer.tsx truncates it at 80 — anything past
    // roughly "Alive" is already invisible there. Placed third it survives in
    // both configurations, at the cost of the tail hint that was sitting on the
    // boundary. `space` (expand the group under the cursor) is not advertised
    // here for the same width reason; it lives in the `?` sheet.
    { keys: "g", label: "Group" },
    ...(debridLabel ? [{ keys: "r", label: debridLabel }] : []),
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
