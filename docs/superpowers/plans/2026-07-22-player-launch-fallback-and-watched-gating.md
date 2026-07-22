# Player launch fallback & watched-tick gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a configured media player fails to launch, offer the user auto-detect / edit / cancel (auto-detect self-heals the saved config), and only mark an episode watched when a player actually starts.

**Architecture:** Extract the automatic launch decision (try configured → else auto-detect) into pure, injectable, unit-tested helpers in `src/util/player.ts`. Keep the Ink wiring in `src/ui/App.tsx` thin: `playStream` calls the helper, routes failures to the right prompt, and fires an `onPlayed` callback only on a real launch. Reuse the existing `ConfirmPrompt` for the 3-way choice (no new component).

**Tech Stack:** TypeScript, React + Ink (TUI), Vitest. Commands: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

---

## File structure

- **Modify** `src/util/player.ts` — add `PlayDeps`, `AutoPlayOutcome`, `detectAndPlay`, `attemptAutoPlay`. Pure logic, no UI.
- **Modify** `src/util/player.test.ts` — add tests for the two new helpers.
- **Modify** `src/ui/App.tsx` — rewrite `playStream`, `playFromPicker`, `setMediaPlayer`, `closePlayerPrompt`; add `pendingStream` + `playerPromptMode` state and `autoDetectPlayer` / `editPlayerCommand` handlers; render `ConfirmPrompt` vs `StreamPlayerPrompt` by mode.

No new files. `ConfirmPrompt` (`src/ui/components/ConfirmPrompt.tsx`) is already imported by `App.tsx` (line 67) and already supports confirm / alt-key / cancel.

---

## Task 1: Pure launch-decision helpers in `player.ts`

**Files:**
- Modify: `src/util/player.ts` (append after `launchPlayer`, end of file)
- Test: `src/util/player.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the top import in `src/util/player.test.ts`:

```ts
import { pickStreamFile, detectPlayer, streamCandidates, attemptAutoPlay, detectAndPlay } from "./player";
```

Append these `describe` blocks to `src/util/player.test.ts`:

```ts
describe("detectAndPlay", () => {
  it("returns the detected player when it launches", async () => {
    const player = await detectAndPlay("http://x", {
      detect: async () => "mpv",
      launch: async () => true,
    });
    expect(player).toBe("mpv");
  });

  it("returns null when detection finds nothing", async () => {
    const player = await detectAndPlay("http://x", {
      detect: async () => null,
      launch: async () => true,
    });
    expect(player).toBeNull();
  });

  it("returns null when the detected player fails to launch", async () => {
    const player = await detectAndPlay("http://x", {
      detect: async () => "mpv",
      launch: async () => false,
    });
    expect(player).toBeNull();
  });
});

describe("attemptAutoPlay", () => {
  it("launches the configured player and reports played", async () => {
    const out = await attemptAutoPlay("vlc.exe", "http://x", {
      launch: async (cmd) => cmd === "vlc.exe",
    });
    expect(out).toEqual({ played: true, player: "vlc.exe", configuredFailed: false });
  });

  it("flags a configured player that fails to launch and does NOT auto-detect", async () => {
    let detected = false;
    const out = await attemptAutoPlay("vlc.exe", "http://x", {
      launch: async () => false,
      detect: async () => {
        detected = true;
        return "mpv";
      },
    });
    expect(out).toEqual({ played: false, configuredFailed: true });
    expect(detected).toBe(false);
  });

  it("auto-detects and launches when nothing is configured", async () => {
    const out = await attemptAutoPlay("", "http://x", {
      detect: async () => "mpv",
      launch: async () => true,
    });
    expect(out).toEqual({ played: true, player: "mpv", configuredFailed: false });
  });

  it("reports not-played (configuredFailed false) when detection finds nothing", async () => {
    const out = await attemptAutoPlay("", "http://x", {
      detect: async () => null,
      launch: async () => true,
    });
    expect(out).toEqual({ played: false, configuredFailed: false });
  });

  it("reports not-played when the detected player fails to launch", async () => {
    const out = await attemptAutoPlay("", "http://x", {
      detect: async () => "mpv",
      launch: async () => false,
    });
    expect(out).toEqual({ played: false, configuredFailed: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/util/player.test.ts`
Expected: FAIL — `attemptAutoPlay is not a function` / `detectAndPlay is not a function` (imports unresolved).

- [ ] **Step 3: Implement the helpers**

Append to the end of `src/util/player.ts` (after `launchPlayer`):

```ts
export interface PlayDeps {
  detect?: () => Promise<string | null>;
  launch?: (command: string, url: string) => Promise<boolean>;
}

// Outcome of the automatic (no-prompt) part of starting playback.
export interface AutoPlayOutcome {
  // A player launched successfully.
  played: boolean;
  // The command/path that launched (present only when played).
  player?: string;
  // A non-empty configured command was tried and failed to launch — the caller
  // should offer the auto-detect/edit choice rather than the plain prompt.
  configuredFailed: boolean;
}

// Auto-detect a player and launch it on the URL. Returns the launched
// command/path (so the caller can persist it) or null when nothing was detected
// or the detected player failed to launch. Deps injectable for testing.
export async function detectAndPlay(url: string, deps: PlayDeps = {}): Promise<string | null> {
  const detect = deps.detect ?? detectPlayer;
  const launch = deps.launch ?? launchPlayer;
  const detected = await detect();
  if (detected && (await launch(detected, url))) return detected;
  return null;
}

// The automatic part of playing a stream: try the configured player first, and
// only auto-detect when nothing is configured. Never prompts or touches config —
// it reports what happened so the UI can decide whether/what to prompt. A
// configured command that fails is reported as configuredFailed (NOT silently
// auto-detected) so the UI can offer the auto-detect/edit choice.
export async function attemptAutoPlay(
  configured: string,
  url: string,
  deps: PlayDeps = {},
): Promise<AutoPlayOutcome> {
  const launch = deps.launch ?? launchPlayer;
  if (configured) {
    if (await launch(configured, url)) {
      return { played: true, player: configured, configuredFailed: false };
    }
    return { played: false, configuredFailed: true };
  }
  const player = await detectAndPlay(url, deps);
  return player
    ? { played: true, player, configuredFailed: false }
    : { played: false, configuredFailed: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/util/player.test.ts`
Expected: PASS (all `attemptAutoPlay` and `detectAndPlay` cases green).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/util/player.ts src/util/player.test.ts
git commit -m "feat(player): add attemptAutoPlay/detectAndPlay launch-decision helpers"
```

---

## Task 2: Wire the fallback prompt and watched-gating into `App.tsx`

All edits land together (the new handlers are referenced by the render block, so the file only compiles once every edit is applied). Apply steps 1–8, then verify with steps 9–12.

**Files:**
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Update the player import**

Replace (line ~17):

```ts
import { detectPlayer, launchPlayer, streamCandidates } from "../util/player";
```

with:

```ts
import { attemptAutoPlay, detectAndPlay, launchPlayer, streamCandidates } from "../util/player";
```

(`detectPlayer` is no longer referenced directly in `App.tsx` — the helpers call it internally.)

- [ ] **Step 2: Replace the `pendingStreamUrl` state with richer pending context + prompt mode**

Replace (line ~165):

```ts
  const [pendingStreamUrl, setPendingStreamUrl] = useState<string | null>(null);
```

with:

```ts
  // Context for a stream awaiting a player-command decision: the URL, an
  // optional display name, an onPlayed callback fired ONLY when a player really
  // launches (e.g. to mark an episode watched), and the configured command that
  // failed (set only for the auto-detect/edit choice prompt).
  const [pendingStream, setPendingStream] = useState<{
    url: string;
    name?: string;
    onPlayed?: () => void;
    configured?: string;
  } | null>(null);
  // Which media-player prompt is showing: the auto-detect/edit choice (after a
  // configured player failed) or the plain command entry.
  const [playerPromptMode, setPlayerPromptMode] = useState<"choice" | "edit">("edit");
```

- [ ] **Step 3: Rewrite `playStream`**

Replace the whole `playStream` callback (lines ~615–634):

```ts
  const playStream = useCallback(
    async (url: string, name?: string) => {
      if (!config) return;
      let player = resolveMediaPlayer(config);
      if (!player) player = (await detectPlayer()) ?? "";
      if (player && (await launchPlayer(player, url))) {
        const copied = await writeClipboard(url);
        setNotice(
          `${ICON.done} Streaming ${name ? `${truncate(cleanText(name), 28)} ` : ""}in ${player}${copied ? " · link copied" : ""}`,
        );
        return;
      }
      // No player available (or it failed to launch): stash the URL, put it on
      // the clipboard, and ask the user for a command to use.
      setPendingStreamUrl(url);
      await writeClipboard(url);
      setEditingPlayer(true);
    },
    [config],
  );
```

with:

```ts
  const playStream = useCallback(
    async (url: string, name?: string, onPlayed?: () => void) => {
      if (!config) return;
      const configured = resolveMediaPlayer(config);
      const outcome = await attemptAutoPlay(configured, url);
      if (outcome.played) {
        const copied = await writeClipboard(url);
        setNotice(
          `${ICON.done} Streaming ${name ? `${truncate(cleanText(name), 28)} ` : ""}in ${outcome.player}${copied ? " · link copied" : ""}`,
        );
        onPlayed?.();
        return;
      }
      // Couldn't play automatically: stash context, copy the link, and open the
      // right prompt — a configured player that failed to launch gets the
      // auto-detect/edit choice; otherwise the plain command entry.
      setPendingStream({
        url,
        name,
        onPlayed,
        configured: outcome.configuredFailed ? configured : undefined,
      });
      await writeClipboard(url);
      setPlayerPromptMode(outcome.configuredFailed ? "choice" : "edit");
      setEditingPlayer(true);
    },
    [config],
  );
```

- [ ] **Step 4: Gate the picker's watched-marking behind `onPlayed`**

Replace the whole `playFromPicker` callback (lines ~649–658):

```ts
  const playFromPicker = useCallback(
    (file: ResolvedFile) => {
      void playStream(file.url, file.filename);
      setStreamedFiles((prev) => new Set(prev).add(file.filename));
      if (streamSource && isFavouritedIn(config?.favourites ?? [], streamSource.id)) {
        markWatchedInFavourite(streamSource.id, file.filename);
      }
    },
    [playStream, streamSource, config, markWatchedInFavourite],
  );
```

with:

```ts
  const playFromPicker = useCallback(
    (file: ResolvedFile) => {
      // Mark streamed/watched ONLY once a player actually launches (the
      // onPlayed callback), so a failed stream never gets a ✓.
      void playStream(file.url, file.filename, () => {
        setStreamedFiles((prev) => new Set(prev).add(file.filename));
        if (streamSource && isFavouritedIn(config?.favourites ?? [], streamSource.id)) {
          markWatchedInFavourite(streamSource.id, file.filename);
        }
      });
    },
    [playStream, streamSource, config, markWatchedInFavourite],
  );
```

- [ ] **Step 5: Update `closePlayerPrompt`**

Replace (lines ~884–888):

```ts
  const closePlayerPrompt = useCallback(() => {
    setEditingPlayer(false);
    setPendingStreamUrl(null);
    setNotice("Stream link is on your clipboard.");
  }, []);
```

with:

```ts
  const closePlayerPrompt = useCallback(() => {
    setEditingPlayer(false);
    setPendingStream(null);
    setNotice("Stream link is on your clipboard.");
  }, []);
```

- [ ] **Step 6: Rewrite `setMediaPlayer` to fire `onPlayed` on a successful launch**

Replace the whole `setMediaPlayer` callback (lines ~890–912):

```ts
  const setMediaPlayer = useCallback(
    (raw: string) => {
      setEditingPlayer(false);
      if (!config) return;
      const cmd = raw.trim();
      const url = pendingStreamUrl;
      setPendingStreamUrl(null);
      if (!cmd) {
        setNotice("Stream link is on your clipboard.");
        return;
      }
      setConfig({ ...config, mediaPlayer: cmd });
      void (async () => {
        if (!url) {
          setNotice(`Media player set: ${cmd}`);
          return;
        }
        const ok = await launchPlayer(cmd, url);
        setNotice(ok ? `${ICON.done} Streaming in ${cmd}` : `Couldn't launch ${cmd}. Link is on your clipboard.`);
      })();
    },
    [config, setConfig, pendingStreamUrl],
  );
```

with:

```ts
  const setMediaPlayer = useCallback(
    (raw: string) => {
      setEditingPlayer(false);
      if (!config) return;
      const cmd = raw.trim();
      const ctx = pendingStream;
      setPendingStream(null);
      if (!cmd) {
        setNotice("Stream link is on your clipboard.");
        return;
      }
      setConfig({ ...config, mediaPlayer: cmd });
      void (async () => {
        if (!ctx?.url) {
          setNotice(`Media player set: ${cmd}`);
          return;
        }
        const ok = await launchPlayer(cmd, ctx.url);
        if (ok) {
          setNotice(`${ICON.done} Streaming in ${cmd}`);
          ctx.onPlayed?.();
        } else {
          setNotice(`Couldn't launch ${cmd}. Link is on your clipboard.`);
        }
      })();
    },
    [config, setConfig, pendingStream],
  );
```

- [ ] **Step 7: Add the auto-detect and edit-choice handlers**

Immediately after the `setMediaPlayer` callback (before `openDnsPrompt` at line ~914), insert:

```ts
  // Auto-detect a working player, launch it, and persist it so a bad saved
  // command self-heals. Falls back to the command-entry prompt when detection
  // finds nothing or the detected player won't launch.
  const autoDetectPlayer = useCallback(() => {
    const ctx = pendingStream;
    if (!config || !ctx) {
      setEditingPlayer(false);
      setPendingStream(null);
      return;
    }
    void (async () => {
      const player = await detectAndPlay(ctx.url);
      if (player) {
        setConfig({ ...config, mediaPlayer: player });
        setNotice(`${ICON.done} Streaming in ${player}`);
        ctx.onPlayed?.();
        setEditingPlayer(false);
        setPendingStream(null);
      } else {
        setNotice("No player detected — enter a command.");
        setPlayerPromptMode("edit");
      }
    })();
  }, [config, pendingStream, setConfig]);

  // Switch the choice prompt to the plain command-entry prompt.
  const editPlayerCommand = useCallback(() => {
    setPlayerPromptMode("edit");
  }, []);
```

- [ ] **Step 8: Render the choice prompt vs the edit prompt by mode**

Replace the player-prompt render block (lines ~1500–1509):

```tsx
        {editingPlayer ? (
          <Box marginTop={1}>
            <StreamPlayerPrompt
              width={Math.max(24, Math.min(cols - 4, 62))}
              value={resolveMediaPlayer(store.config)}
              onSubmit={setMediaPlayer}
              onCancel={closePlayerPrompt}
            />
          </Box>
        ) : null}
```

with:

```tsx
        {editingPlayer ? (
          <Box marginTop={1}>
            {playerPromptMode === "choice" && pendingStream?.configured ? (
              <ConfirmPrompt
                width={Math.max(24, Math.min(cols - 4, 62))}
                title="media player"
                message={`Couldn't launch "${pendingStream.configured}". Auto-detect a player?`}
                altKey="e"
                altLabel="edit command"
                onConfirm={autoDetectPlayer}
                onAlt={editPlayerCommand}
                onCancel={closePlayerPrompt}
              />
            ) : (
              <StreamPlayerPrompt
                width={Math.max(24, Math.min(cols - 4, 62))}
                value={resolveMediaPlayer(store.config)}
                onSubmit={setMediaPlayer}
                onCancel={closePlayerPrompt}
              />
            )}
          </Box>
        ) : null}
```

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no errors (in particular, no "declared but never read" for `pendingStream`, `playerPromptMode`, `autoDetectPlayer`, `editPlayerCommand`, or a removed `detectPlayer` import).

- [ ] **Step 10: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 11: Run the full test suite**

Run: `npm test`
Expected: PASS (existing suites plus Task 1's new tests; no regressions).

- [ ] **Step 12: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(stream): offer auto-detect/edit when a configured player fails; mark watched only on successful launch"
```

---

## Task 3: Manual verification of the end-to-end flow

**Files:** none (verification only).

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: build succeeds (no type/bundle errors).

- [ ] **Step 2: Reproduce the trap, then confirm the fix**

Temporarily point config at a bad player and launch the dev app:

Run (bash): `TORLINK_PLAYER=definitely-not-a-real-player npm run dev`

Then start a stream (`v`) on any resolved item and confirm:
- The **choice prompt** appears: `Couldn't launch "definitely-not-a-real-player". Auto-detect a player?` with `e edit command` and `esc cancel` hints.
- Pressing `y`/`enter` (**Auto-detect**) launches a detected player if one exists, or shows "No player detected — enter a command." and switches to the text-entry prompt.
- Pressing `e` switches to the text-entry prompt.
- Pressing `esc` closes with "Stream link is on your clipboard."
- In a favourited series, the episode's ✓ appears **only** after a player actually launches — cancelling leaves no ✓.

(Using `TORLINK_PLAYER` avoids editing the real `config.json`; it overrides `mediaPlayer` per `resolveMediaPlayer`.)

- [ ] **Step 3: No commit needed** — verification only. If a defect is found, return to Task 2, fix, and re-run steps 9–12 there.

---

## Self-review notes

- **Spec coverage:** configured-failure → choice prompt (Task 2 steps 3, 7, 8); auto-detect overwrites config (Task 2 step 7 `setConfig`); `onPlayed` gating (Task 2 steps 3, 4, 6); pending-state widening (step 2); pure tested helper (Task 1); `ConfirmPrompt` reuse instead of a new component (Task 2 step 8). Out-of-scope items (no `launchPlayer` internal change, no OS-error text) are respected.
- **Type consistency:** `AutoPlayOutcome` (`played`, `player?`, `configuredFailed`) is produced by `attemptAutoPlay` (Task 1) and consumed in `playStream` (Task 2 step 3). `pendingStream` shape (`url`, `name?`, `onPlayed?`, `configured?`) is set in steps 3/7 and read in steps 6/7/8. `detectAndPlay(url, deps)` signature matches its call in step 7. `PlayDeps` (`detect?`, `launch?`) matches all test injections.
