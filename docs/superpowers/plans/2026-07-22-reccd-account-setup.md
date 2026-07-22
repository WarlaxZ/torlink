# reccd Account Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user configure the reccd connection (URL + token) from within torlink's Accounts pane, persisted to `config.json` (no env vars needed), with a live reachability status, framed as a private/self-hosted service.

**Architecture:** Mirrors the Real-Debrid account flow. A `src/recc/status.ts` module pings reccd's `GET /profile` and classifies the connection. A `ReccdPrompt` two-field prompt (modeled on `RutrackerPrompt`) captures URL + token. The `Accounts` pane gains a third row. `App.tsx` wires prompt lifecycle, config save, and status refresh exactly like the token/rutracker prompts.

**Tech Stack:** TypeScript, React + Ink, Vitest, `ink-testing-library`, `undici` fetch. Tests: `npx vitest run <path>`; typecheck: `npx tsc --noEmit`. Run from the worktree.

**Working directory:** `/home/ash/projects/torlink/.claude/worktrees/squishy-snuggling-bengio` (branch `docs/recommendation-engine-spec`).

**Spec:** `docs/superpowers/specs/2026-07-22-reccd-account-setup-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/recc/status.ts` (create) | `checkReccConnection` (pings `/profile`) + `formatReccStatus` + types. |
| `src/recc/status.test.ts` (create) | Classification + formatting tests. |
| `src/ui/components/ReccdPrompt.tsx` (create) | Two-field (URL + token) setup prompt. |
| `src/ui/components/ReccdPrompt.test.tsx` (create) | Prompt render/submit/cancel tests. |
| `src/ui/components/Accounts.tsx` (modify) | Add the reccd row + props; parametrize row labels/status icon. |
| `src/ui/components/Accounts.test.tsx` (modify) | Cover the reccd row. |
| `src/ui/App.tsx` (modify) | reccd status state, prompt lifecycle, config save/clear, input suppression, Accounts props. |
| `src/ui/components/ForYou.tsx` (modify) | Point the not-configured hint at the Accounts pane. |
| `src/ui/components/ForYou.test.tsx` (modify) | Update the hint assertion. |

---

## Task 1: reccd connection status module

**Files:**
- Create: `src/recc/status.ts`
- Test: `src/recc/status.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/recc/status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { checkReccConnection, formatReccStatus } from "./status";
import type { FetchImpl } from "../util/net";

function fakeFetch(handler: (url: string) => { status: number; throwErr?: boolean }): FetchImpl {
  return (async (url: string) => {
    const r = handler(String(url));
    if (r.throwErr) throw new Error("network down");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => ({}) } as unknown as Response;
  }) as unknown as FetchImpl;
}

const CFG = { reccUrl: "http://192.168.0.98:4100", reccToken: "tok" };

describe("checkReccConnection", () => {
  it("returns unconfigured when reccUrl is missing", async () => {
    expect(await checkReccConnection({ reccToken: "t" })).toEqual({ state: "unconfigured" });
  });

  it("returns connected on 200", async () => {
    const res = await checkReccConnection(CFG, { fetchImpl: fakeFetch(() => ({ status: 200 })) });
    expect(res).toEqual({ state: "connected", host: "192.168.0.98:4100" });
  });

  it("returns badToken on 401", async () => {
    const res = await checkReccConnection(CFG, { fetchImpl: fakeFetch(() => ({ status: 401 })) });
    expect(res).toEqual({ state: "badToken", host: "192.168.0.98:4100" });
  });

  it("returns unreachable on other non-2xx", async () => {
    const res = await checkReccConnection(CFG, { fetchImpl: fakeFetch(() => ({ status: 500 })) });
    expect(res).toEqual({ state: "unreachable", host: "192.168.0.98:4100" });
  });

  it("returns unreachable on a network error", async () => {
    const res = await checkReccConnection(CFG, { fetchImpl: fakeFetch(() => ({ status: 0, throwErr: true })) });
    expect(res).toEqual({ state: "unreachable", host: "192.168.0.98:4100" });
  });

  it("hits the /profile endpoint with a bearer header", async () => {
    let seen = "";
    const impl = (async (url: string, init: { headers?: Record<string, string> }) => {
      seen = String(url);
      expect(init.headers?.authorization).toBe("Bearer tok");
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as FetchImpl;
    await checkReccConnection(CFG, { fetchImpl: impl });
    expect(seen).toBe("http://192.168.0.98:4100/profile");
  });
});

describe("formatReccStatus", () => {
  it("formats each state", () => {
    expect(formatReccStatus(null)).toBe("Not configured");
    expect(formatReccStatus({ state: "unconfigured" })).toBe("Not configured");
    expect(formatReccStatus({ state: "connected", host: "h:4100" })).toBe("Connected · h:4100");
    expect(formatReccStatus({ state: "badToken", host: "h:4100" })).toBe("Token rejected");
    expect(formatReccStatus({ state: "unreachable", host: "h:4100" })).toBe("Unreachable · h:4100");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/recc/status.test.ts`
Expected: FAIL — `./status` does not exist.

- [ ] **Step 3: Implement `src/recc/status.ts`**

```ts
import type { FetchImpl } from "../util/net";
import type { ReccClientConfig } from "./client";

export type ReccConnection = "unconfigured" | "connected" | "badToken" | "unreachable";

export interface ReccStatus {
  state: ReccConnection;
  host?: string;
}

function hostOf(reccUrl: string): string {
  try {
    return new URL(reccUrl).host || reccUrl;
  } catch {
    return reccUrl;
  }
}

// Pings reccd's authenticated GET /profile to classify the connection for the
// Accounts pane. Never throws — network/timeout/other errors map to
// "unreachable". /profile is a cheap authenticated GET that cleanly separates
// 200 (connected) from 401 (bad token).
export async function checkReccConnection(
  config: ReccClientConfig,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<ReccStatus> {
  if (!config.reccUrl) return { state: "unconfigured" };
  const host = hostOf(config.reccUrl);
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchImpl);
  try {
    const res = await fetchImpl(`${config.reccUrl}/profile`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.reccToken ?? ""}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
    });
    if (res.status === 401) return { state: "badToken", host };
    if (!res.ok) return { state: "unreachable", host };
    return { state: "connected", host };
  } catch {
    return { state: "unreachable", host };
  }
}

// One-line status for the Accounts row / setup prompt.
export function formatReccStatus(status: ReccStatus | null): string {
  if (!status || status.state === "unconfigured") return "Not configured";
  switch (status.state) {
    case "connected":
      return `Connected · ${status.host}`;
    case "badToken":
      return "Token rejected";
    case "unreachable":
      return `Unreachable · ${status.host}`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/recc/status.test.ts` → PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/recc/status.ts src/recc/status.test.ts
git commit -m "feat(recc): add reccd connection status check"
```

---

## Task 2: `ReccdPrompt` two-field setup prompt

**Files:**
- Create: `src/ui/components/ReccdPrompt.tsx`
- Test: `src/ui/components/ReccdPrompt.test.tsx`

Note: this mirrors `src/ui/components/RutrackerPrompt.tsx` (two fields, a `Field` helper, ↑↓ to move, esc to cancel). READ that file first to match the exact `TextField`/`Panel`/`Field` usage before implementing.

- [ ] **Step 1: Write the failing test**

Create `src/ui/components/ReccdPrompt.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { ReccdPrompt } from "./ReccdPrompt";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const ESC = String.fromCharCode(27);

describe("ReccdPrompt", () => {
  it("renders URL and Token fields and the status line", () => {
    const { lastFrame } = render(
      <ReccdPrompt width={60} url="" token="" status={{ state: "unconfigured" }} onSubmit={() => {}} onCancel={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("URL");
    expect(frame).toContain("Token");
    expect(frame).toContain("Not configured");
  });

  it("cancels on escape", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      <ReccdPrompt width={60} url="" token="" status={null} onSubmit={() => {}} onCancel={onCancel} />,
    );
    await flush();
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalled();
  });

  it("submits the entered url and token", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <ReccdPrompt width={60} url="" token="" status={null} onSubmit={onSubmit} onCancel={() => {}} />,
    );
    await flush();
    stdin.write("http://h:4100"); // typed into the focused URL field
    await flush();
    stdin.write("\r"); // enter on URL advances to the Token field
    await flush();
    stdin.write("tok"); // typed into the Token field
    await flush();
    stdin.write("\r"); // enter on Token submits
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("http://h:4100", "tok");
  });
});
```

If the exact keystroke flow in the third test doesn't line up with how `TextField` reports `onChange`/`onSubmit` (read `TextField.tsx` and `RutrackerPrompt` behaviour), adjust the *interaction* (how fields are advanced) so it passes — but keep the assertion that `onSubmit` receives the entered URL and token. Do not weaken it to a render-only check.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/components/ReccdPrompt.test.tsx`
Expected: FAIL — cannot find `./ReccdPrompt`.

- [ ] **Step 3: Implement `src/ui/components/ReccdPrompt.tsx`**

```tsx
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField";
import { Panel } from "./Panel";
import { COLOR, ICON } from "../theme";
import { formatReccStatus, type ReccStatus } from "../../recc/status";

type FieldKey = "url" | "token";

interface ReccdPromptProps {
  width: number;
  url: string;
  token: string;
  status: ReccStatus | null;
  onSubmit: (url: string, token: string) => void;
  onCancel: () => void;
}

function Field({
  label,
  active,
  children,
}: {
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Box width={8} flexShrink={0}>
        <Text color={active ? COLOR.accent : undefined} dimColor={!active}>
          {label}
        </Text>
      </Box>
      <Text color={active ? COLOR.accent : COLOR.alt}>{`${ICON.pointer} `}</Text>
      <Box flexGrow={1} minWidth={0}>
        {children}
      </Box>
    </Box>
  );
}

// A private, self-hosted service — reccd is a single URL + bearer token the user
// stands up themselves. Two fields, modeled on RutrackerPrompt.
export function ReccdPrompt({ width, url, token, status, onSubmit, onCancel }: ReccdPromptProps) {
  const [field, setField] = useState<FieldKey>("url");
  const [urlVal, setUrlVal] = useState(url);
  const [tokenVal, setTokenVal] = useState(token);

  const submit = (): void => onSubmit(urlVal.trim(), tokenVal);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) setField("url");
    else if (key.downArrow) setField("token");
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title="reccd — private, self-hosted recommendations" width={width} focused height={4}>
        <Field label="URL" active={field === "url"}>
          <TextField
            isDisabled={field !== "url"}
            defaultValue={url}
            placeholder="http://localhost:4100"
            onChange={setUrlVal}
            onSubmit={() => setField("token")}
            onExitDown={() => setField("token")}
          />
        </Field>
        <Field label="Token" active={field === "token"}>
          <TextField
            isDisabled={field !== "token"}
            mask
            defaultValue={token}
            placeholder="bearer token from reccd `user:add`"
            onChange={setTokenVal}
            onSubmit={submit}
          />
        </Field>
        <Box marginTop={1}>
          <Text dimColor>{`status: ${formatReccStatus(status)}`}</Text>
        </Box>
      </Panel>
      <Box marginTop={1}>
        <Text color={COLOR.alt}>↵</Text>
        <Text dimColor> next / save</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>↑↓</Text>
        <Text dimColor> field</Text>
        <Text dimColor>{`     ${ICON.dot}     `}</Text>
        <Text color={COLOR.alt}>esc</Text>
        <Text dimColor> cancel</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/components/ReccdPrompt.test.tsx` → PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/ReccdPrompt.tsx src/ui/components/ReccdPrompt.test.tsx
git commit -m "feat(ui): add ReccdPrompt setup prompt (url + token)"
```

---

## Task 3: reccd row in the Accounts pane

**Files:**
- Modify: `src/ui/components/Accounts.tsx`
- Test: `src/ui/components/Accounts.test.tsx`

- [ ] **Step 1: Update the test first**

Replace the whole contents of `src/ui/components/Accounts.test.tsx` with:

```tsx
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StoreContext, type Store } from "../store";
import { Accounts } from "./Accounts";
import type { ReccStatus } from "../../recc/status";

function storeStub(): Store {
  return { region: "content", section: "accounts" } as unknown as Store;
}

const noop = () => {};
const baseProps = {
  rdToken: "",
  rdStatus: null,
  rutrackerUser: undefined as string | undefined,
  reccConfigured: false,
  reccStatus: null as ReccStatus | null,
  reccEnvOverride: false,
  onManageRd: noop,
  onSignOutRd: noop,
  onManageRutracker: noop,
  onSignOutRutracker: noop,
  onManageRecc: noop,
  onSignOutRecc: noop,
};

function renderAccounts(overrides: Partial<typeof baseProps> = {}) {
  return render(
    <StoreContext.Provider value={storeStub()}>
      <Accounts {...baseProps} {...overrides} />
    </StoreContext.Provider>,
  );
}

describe("Accounts", () => {
  it("lists Real-Debrid, RuTracker and reccd", () => {
    const frame = renderAccounts().lastFrame() ?? "";
    expect(frame).toContain("Real-Debrid");
    expect(frame).toContain("RuTracker");
    expect(frame).toContain("reccd");
  });

  it("shows Not configured for reccd when unconfigured", () => {
    expect(renderAccounts().lastFrame() ?? "").toContain("Not configured");
  });

  it("shows the RuTracker username when signed in", () => {
    const frame = renderAccounts({ rutrackerUser: "alice" }).lastFrame() ?? "";
    expect(frame).toContain("alice");
  });

  it("shows connected status when reccd is configured and reachable", () => {
    const frame = renderAccounts({
      reccConfigured: true,
      reccStatus: { state: "connected", host: "192.168.0.98:4100" },
    }).lastFrame() ?? "";
    expect(frame).toContain("Connected");
  });

  it("notes an env override when reccEnvOverride is set", () => {
    const frame = renderAccounts({
      reccConfigured: true,
      reccStatus: { state: "connected", host: "h:4100" },
      reccEnvOverride: true,
    }).lastFrame() ?? "";
    expect(frame).toContain("env override");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/components/Accounts.test.tsx`
Expected: FAIL — new props/row not present yet.

- [ ] **Step 3: Replace `src/ui/components/Accounts.tsx`**

Replace the whole file with (adds the reccd row and parametrizes per-row labels + a status `ok` flag; Real-Debrid/RuTracker output is unchanged because their defaults match the previous hardcoded strings):

```tsx
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { Panel } from "./Panel";
import { wrapStep } from "../move";
import { COLOR, GUTTER, ICON } from "../theme";
import { truncate } from "../../util/format";
import { formatAccountStatus, type RdStatus } from "../../integrations/rdStatus";
import { formatReccStatus, type ReccStatus } from "../../recc/status";

interface AccountsProps {
  rdToken: string;
  rdStatus: RdStatus | null;
  rutrackerUser?: string;
  reccConfigured: boolean;
  reccStatus: ReccStatus | null;
  reccEnvOverride?: boolean;
  // True while a torrent stream is active; "x" is reserved for stopping it
  // globally, so sign-out must not also fire on the same keystroke.
  streamActive?: boolean;
  onManageRd: () => void;
  onSignOutRd: () => void;
  onManageRutracker: () => void;
  onSignOutRutracker: () => void;
  onManageRecc: () => void;
  onSignOutRecc: () => void;
}

interface Row {
  tag: string;
  color: string;
  label: string;
  homepage: string;
  signedIn: boolean;
  // Drives the status icon/colour when signedIn: green tick when true, a warn
  // marker otherwise (e.g. reccd configured but unreachable / bad token).
  ok: boolean;
  status: string;
  emptyStatus: string;
  verbSignedIn: string;
  verbSignOut: string;
  verbSignedOut: string;
  onManage: () => void;
  onSignOut: () => void;
}

export function Accounts({
  rdToken,
  rdStatus,
  rutrackerUser,
  reccConfigured,
  reccStatus,
  reccEnvOverride = false,
  streamActive = false,
  onManageRd,
  onSignOutRd,
  onManageRutracker,
  onSignOutRutracker,
  onManageRecc,
  onSignOutRecc,
}: AccountsProps) {
  const { region, section, contentWidth, listRows } = useStore();
  const focused = region === "content" && section === "accounts";
  const [cursor, setCursor] = useState(0);

  const rows: Row[] = [
    {
      tag: "RD",
      color: COLOR.good,
      label: "Real-Debrid",
      homepage: "real-debrid.com",
      signedIn: rdToken !== "",
      ok: rdToken !== "",
      status: formatAccountStatus(rdStatus, new Date()),
      emptyStatus: "Not connected",
      verbSignedIn: "switch",
      verbSignOut: "sign out",
      verbSignedOut: "sign in",
      onManage: onManageRd,
      onSignOut: onSignOutRd,
    },
    {
      tag: "RUT",
      color: "#8fce5a",
      label: "RuTracker",
      homepage: "rutracker.org",
      signedIn: !!rutrackerUser,
      ok: !!rutrackerUser,
      status: rutrackerUser ? `Signed in as ${truncate(rutrackerUser, 24)}` : "Not signed in",
      emptyStatus: "Not signed in",
      verbSignedIn: "switch",
      verbSignOut: "sign out",
      verbSignedOut: "sign in",
      onManage: onManageRutracker,
      onSignOut: onSignOutRutracker,
    },
    {
      tag: "RCD",
      color: COLOR.accent,
      label: "reccd",
      homepage: "self-hosted · private service",
      signedIn: reccConfigured,
      ok: reccStatus?.state === "connected",
      status: `${formatReccStatus(reccStatus)}${reccEnvOverride ? "  ·  env override active" : ""}`,
      emptyStatus: "Not configured",
      verbSignedIn: "edit",
      verbSignOut: "clear",
      verbSignedOut: "set up",
      onManage: onManageRecc,
      onSignOut: onSignOutRecc,
    },
  ];

  const clamped = Math.min(cursor, rows.length - 1);

  useInput(
    (input, key) => {
      if (key.upArrow) setCursor(wrapStep(clamped, -1, rows.length));
      else if (key.downArrow) setCursor(wrapStep(clamped, 1, rows.length));
      else if (key.return) rows[clamped]!.onManage();
      else if (input === "x" && !streamActive && rows[clamped]!.signedIn) rows[clamped]!.onSignOut();
    },
    { isActive: focused },
  );

  const panelH = Math.max(5, listRows - 1);

  return (
    <Panel title="accounts" width={contentWidth} focused={focused} height={panelH}>
      <Box>
        <Text dimColor>Sign in to services that need an account to search or stream.</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((r, i) => {
          const here = i === clamped && focused;
          return (
            <Box key={r.label} marginTop={i > 0 ? 1 : 0}>
              <Box width={GUTTER} flexShrink={0}>
                <Text color={COLOR.accent} bold>{here ? ICON.pointer : ""}</Text>
              </Box>
              <Box width={5} flexShrink={0}>
                <Text color={r.color} bold={here}>{r.tag}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0} marginLeft={1} flexDirection="column">
                <Text bold={here} color={here ? COLOR.accent : undefined} dimColor={!here}>
                  {r.label}
                  <Text dimColor>{`  ${ICON.dot} ${r.homepage}`}</Text>
                </Text>
                {r.signedIn ? (
                  <Text>
                    <Text color={r.ok ? COLOR.good : COLOR.warn}>{`${r.ok ? ICON.done : ICON.warn} `}</Text>
                    <Text dimColor>{r.status}</Text>
                  </Text>
                ) : (
                  <Text dimColor>{`${ICON.dot} ${r.emptyStatus}`}</Text>
                )}
              </Box>
              <Box flexShrink={0} marginLeft={1}>
                {r.signedIn ? (
                  <Text>
                    <Text color={COLOR.alt}>↵</Text>
                    <Text dimColor>{` ${r.verbSignedIn}`}</Text>
                    <Text dimColor>{`  ${ICON.dot}  `}</Text>
                    <Text color={COLOR.alt}>x</Text>
                    <Text dimColor>{` ${r.verbSignOut}`}</Text>
                  </Text>
                ) : (
                  <Text>
                    <Text color={COLOR.alt}>↵</Text>
                    <Text dimColor>{` ${r.verbSignedOut}`}</Text>
                  </Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Panel>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/components/Accounts.test.tsx` → PASS. Then `npx tsc --noEmit` (App.tsx will now have type errors because it doesn't pass the new required `Accounts` props yet — that's expected and fixed in Task 4; if you want a clean tsc for this task alone, note it and proceed).

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/Accounts.tsx src/ui/components/Accounts.test.tsx
git commit -m "feat(ui): add reccd row to the Accounts pane"
```

---

## Task 4: Wire the reccd prompt, status, and config save into App

**Files:**
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/components/ForYou.tsx`
- Modify: `src/ui/components/ForYou.test.tsx`

This task follows the existing Real-Debrid token / RuTracker prompt patterns exactly. READ these regions of `App.tsx` first: the imports block, the `editingToken` state + `openTokenPrompt`/`setRealDebridToken`/`clearRealDebridToken` handlers, the `<TokenPrompt/>` render block, the `<Accounts/>` block, the `persistConfig` helper, the `store` `useMemo` (region computation), and the two `display` conditions (body + footer). Mirror the token prompt for reccd.

- [ ] **Step 1: Add imports**

In `src/ui/App.tsx`, add:
```tsx
import { ReccdPrompt } from "./components/ReccdPrompt";
import { checkReccConnection, type ReccStatus } from "../recc/status";
```

- [ ] **Step 2: Add state**

Near the other prompt/state declarations (e.g. beside `const [editingToken, setEditingToken] = useState(false);`):
```tsx
  const [editingRecc, setEditingRecc] = useState(false);
  const [reccStatus, setReccStatus] = useState<ReccStatus | null>(null);
```

- [ ] **Step 3: Add a status refresher + a refresh effect**

Add this callback near the other `useCallback` handlers:
```tsx
  const refreshReccStatus = useCallback((cfg: Config | null) => {
    const rc = cfg ? resolveReccConfig(cfg) : {};
    if (!rc.reccUrl) {
      setReccStatus(null);
      return;
    }
    void checkReccConnection(rc).then(setReccStatus);
  }, []);
```

Add this effect (near other effects) so status is checked on load and whenever the reccd config changes:
```tsx
  useEffect(() => {
    refreshReccStatus(config);
  }, [config?.reccUrl, config?.reccToken, refreshReccStatus]);
```

- [ ] **Step 4: Add open / save / clear handlers**

Mirror `openTokenPrompt` / `setRealDebridToken` / `clearRealDebridToken`:
```tsx
  const closeReccPrompt = useCallback(() => setEditingRecc(false), []);

  const openReccPrompt = useCallback(() => {
    setView("browser");
    setShowHelp(false);
    setEditingRecc(true);
    refreshReccStatus(config);
  }, [config, refreshReccStatus]);

  const saveReccConfig = useCallback(
    (rawUrl: string, rawToken: string) => {
      closeReccPrompt();
      const url = rawUrl.trim().replace(/\/+$/, "");
      const token = rawToken.trim();
      persistConfig({ reccUrl: url || undefined, reccToken: token || undefined });
      setNotice(url ? `${ICON.done} reccd set to ${url}` : "reccd connection cleared.");
    },
    [closeReccPrompt],
  );

  const clearReccConfig = useCallback(() => {
    closeReccPrompt();
    if (process.env["TORLINK_RECC_URL"]?.trim() || process.env["TORLINK_RECC_TOKEN"]?.trim()) {
      setNotice("reccd is set via TORLINK_RECC_* env vars — unset them to clear it.");
      return;
    }
    persistConfig({ reccUrl: undefined, reccToken: undefined });
    setNotice("reccd connection cleared.");
  }, [closeReccPrompt],
  );
```
(`persistConfig` triggers a config change, which fires the effect from Step 3 and refreshes the status automatically. `setNotice`, `ICON`, `persistConfig`, `resolveReccConfig`, `setView`, `setShowHelp` are all already in scope/imported.)

- [ ] **Step 5: Suppress global input while the reccd prompt is open**

The reccd prompt contains editable `TextField`s, so the global `useInput` and the focused content pane must NOT react while it's open (otherwise typing a URL/token triggers global shortcuts — the same class of bug that hit the genre prompt). Replicate EXACTLY how `editingToken` does this: grep `editingToken` across `App.tsx` and add `editingRecc` in the same way at each site. Concretely, that means adding `editingRecc` to:
- the `store` `useMemo` `region` condition (so `region` becomes `"help"` while editing, gating the content panes' `useInput`),
- the **body** region `display` condition,
- the **footer** `display` condition,
- and any early-return guard for prompts inside the global `useInput` handler (if `editingToken` has one there; match it).

After editing, reason through: while `editingRecc` is true, does any global single-letter binding still fire on a keystroke? It must not. (If `editingToken` relies on a `captureMode === "text"` guard rather than an explicit early return, do NOT try to replicate that — `ReccdPrompt` owns its own input; the region+display gating plus mirroring editingToken's sites is what's needed. If unsure whether suppression is complete, report it rather than guessing.)

- [ ] **Step 6: Render the prompt**

Next to the `{editingToken ? (…<TokenPrompt/>…) : null}` block, add:
```tsx
{editingRecc ? (
  <Box marginTop={1}>
    <ReccdPrompt
      width={Math.max(24, Math.min(cols - 4, 62))}
      url={store.config.reccUrl ?? ""}
      token={store.config.reccToken ?? ""}
      status={reccStatus}
      onSubmit={saveReccConfig}
      onCancel={closeReccPrompt}
    />
  </Box>
) : null}
```

- [ ] **Step 7: Pass the new props to `<Accounts/>`**

Update the `<Accounts …/>` element to add:
```tsx
        reccConfigured={store.reccConfigured}
        reccStatus={reccStatus}
        reccEnvOverride={Boolean(process.env["TORLINK_RECC_URL"]?.trim() || process.env["TORLINK_RECC_TOKEN"]?.trim())}
        onManageRecc={openReccPrompt}
        onSignOutRecc={clearReccConfig}
```
(`store.reccConfigured` already exists from earlier work.)

- [ ] **Step 8: Point the For You not-configured hint at Accounts**

In `src/ui/components/ForYou.tsx`, replace the not-configured hint block:
```tsx
      <Box flexDirection="column">
        <Text color={COLOR.text}>Recommendations aren't set up yet.</Text>
        <Text dimColor>To set up, add reccUrl and reccToken to config.json,</Text>
        <Text dimColor>or set TORLINK_RECC_URL / TORLINK_RECC_TOKEN.</Text>
      </Box>
```
with:
```tsx
      <Box flexDirection="column">
        <Text color={COLOR.text}>Recommendations aren't set up yet.</Text>
        <Text dimColor>Set up reccd in the Accounts pane (↵ on reccd),</Text>
        <Text dimColor>or set TORLINK_RECC_URL / TORLINK_RECC_TOKEN.</Text>
      </Box>
```
Then in `src/ui/components/ForYou.test.tsx`, update the setup-hint assertion (which currently checks `"set up"`) to match the new copy:
```tsx
    expect(lastFrame()).toContain("Accounts");
```

- [ ] **Step 9: Typecheck and run the full suite**

Run: `npx tsc --noEmit` → no errors.
Run: `npx vitest run` → whole suite green. (Ignore the KNOWN-FLAKY `src/download/queue.test.ts` RD test that fails only in full runs and passes alone — pre-existing/unrelated; confirm by running it in isolation if it fails.)

- [ ] **Step 10: Commit**

```bash
git add src/ui/App.tsx src/ui/components/ForYou.tsx src/ui/components/ForYou.test.tsx
git commit -m "feat(ui): wire reccd account setup (prompt, status, config save) into App"
```

---

## Self-Review

**Spec coverage:**
- Accounts row (tag RCD, "self-hosted · private service", manage/clear) → Task 3. ✓
- Two-field setup prompt saving to config.json → Task 2 + Task 4 (save handler). ✓
- Live reachability status (`connected`/`badToken`/`unreachable`/`unconfigured`) → Task 1, surfaced in Task 3 row + Task 2 prompt + Task 4 refresh. ✓
- Env-override note → Task 3 row + Task 4 prop. ✓
- Persistence to config.json (no env vars); env still wins → Task 4 (`persistConfig`), `resolveReccConfig` unchanged. ✓
- For You hint points at Accounts → Task 4 Step 8. ✓
- Input suppression while prompt open → Task 4 Step 5. ✓

**Type consistency:** `ReccStatus`/`ReccConnection` defined in Task 1 and imported unchanged by `ReccdPrompt` (Task 2), `Accounts` (Task 3), and `App` (Task 4). `AccountsProps` gains `reccConfigured`/`reccStatus`/`reccEnvOverride`/`onManageRecc`/`onSignOutRecc` in Task 3 and App passes exactly those in Task 4. `checkReccConnection`/`formatReccStatus` signatures are stable across tasks.

**Placeholder scan:** none — every code/test step is complete.

**Ordering note for the implementer:** after Task 3, `tsc` over the whole project will error until Task 4 wires the new `Accounts` props — this is expected; Task 3's own test still passes. Do the tasks in order.
