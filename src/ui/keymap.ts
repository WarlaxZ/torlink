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
      { keys: "↑ ↓ ← →, h j k l", label: "Navigate content and panes" },
      { keys: "↵", label: "Open" },
      { keys: "tab", label: "Switch pane" },
      { keys: "esc", label: "Back" },
      { keys: "o", label: "Download folder" },
      { keys: "S", label: "Choose sources" },
      { keys: "D", label: "Custom DNS (bypass blocked networks)" },
      { keys: "t", label: "Extra trackers" },
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
      { keys: "s", label: "Sort results" },
      { keys: "z", label: "Hide results with no seeders" },
      { keys: "d", label: "Download (P2P)" },
      { keys: "r", label: "Download via Real-Debrid" },
      { keys: "v", label: "Stream" },
      { keys: "y", label: "Copy magnet" },
      { keys: "m", label: "Paste magnet" },
      { keys: "x", label: "Stop active stream" },
    ],
  },
  {
    title: "Downloads",
    hints: [
      { keys: "p", label: "Pause/resume" },
      { keys: "c", label: "Cancel or remove from list" },
      { keys: "f", label: "Retry failed" },
      { keys: "d", label: "Download again" },
      { keys: "e", label: "Open folder" },
      { keys: "x", label: "Clear recent" },
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
// overlay (HELP_GROUPS) carries the full, descriptive list.
const NAVIGATE: Hint = { keys: "↑↓←→", label: "Move" };

const ALWAYS: Hint = { keys: "?", label: "Keys" };

const SWITCH: Hint = { keys: "tab", label: "Switch" };

const FOLDER: Hint = { keys: "e", label: "Folder" };

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
    return [{ keys: "p", label }, { keys: "c", label: "Remove" }, FOLDER, SWITCH, ALWAYS];
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
  if (section === "downloads") {
    if (downloadFocus === "paused") {
      return [{ keys: "p", label: "Resume" }, { keys: "c", label: "Cancel" }, FOLDER, SWITCH, ALWAYS];
    }
    if (downloadFocus === "failed") {
      return [{ keys: "f", label: "Retry" }, { keys: "c", label: "Remove" }, FOLDER, SWITCH, ALWAYS];
    }
    if (downloadFocus === "recent") {
      return [
        NAVIGATE,
        { keys: "d", label: "Redownload" },
        { keys: "c", label: "Remove" },
        { keys: "x", label: "Clear" },
        FOLDER,
        SWITCH,
        ALWAYS,
      ];
    }
    return [
      { keys: "p", label: "Pause" },
      { keys: "c", label: "Cancel" },
      { keys: "y", label: "Link" },
      FOLDER,
      SWITCH,
      ALWAYS,
    ];
  }
  return [
    NAVIGATE,
    { keys: "d", label: "Download" },
    ...(debridConfigured ? [{ keys: "r", label: "Real-Debrid" }] : []),
    { keys: "v", label: "Stream" },
    { keys: "y", label: "Copy" },
    { keys: "s", label: "Sort" },
    { keys: "z", label: "Alive" },
    { keys: "/", label: "Search" },
    SWITCH,
    ALWAYS,
  ];
}
