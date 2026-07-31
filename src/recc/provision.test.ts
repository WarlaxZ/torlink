import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RECC_URL, shouldProvision, ensureReccAccount, type ProvisionedPatch } from "./provision";
import { defaultConfig, type Config } from "../config/config";
import type { FetchImpl } from "../util/net";

const base = (over: Partial<Config> = {}): Config => ({ ...defaultConfig, downloadDir: "/tmp/dl", ...over });

describe("shouldProvision", () => {
  beforeEach(() => {
    // resolveReccConfig reads these, and a developer may well have them
    // exported -- without stubbing, half these cases pass by accident.
    vi.stubEnv("TORLINK_RECC_URL", "");
    vi.stubEnv("TORLINK_RECC_TOKEN", "");
  });

  it("is true on a fresh install with nothing configured", () => {
    expect(shouldProvision(base())).toBe(true);
  });

  it("is false once a token exists — the account is already there", () => {
    expect(shouldProvision(base({ reccToken: "tok" }))).toBe(false);
  });

  it("is false when TORLINK_RECC_TOKEN supplies the token", () => {
    vi.stubEnv("TORLINK_RECC_TOKEN", "from-env");
    expect(shouldProvision(base())).toBe(false);
  });

  // The case that matters: a self-hosted reccd is not ours to sign up against,
  // and signing up against reccd.stream instead would ignore what the user set.
  it("is false for a self-hosted reccUrl with no token", () => {
    expect(shouldProvision(base({ reccUrl: "http://192.168.0.98:4100" }))).toBe(false);
  });

  it("is false for a self-hosted TORLINK_RECC_URL with no token", () => {
    vi.stubEnv("TORLINK_RECC_URL", "http://192.168.0.98:4100");
    expect(shouldProvision(base())).toBe(false);
  });

  // The hand-setup user who typed the host and left the token blank. Signing
  // them up against the host they already named is what they were trying to do.
  it("is true when reccUrl is already the default host but no token is set", () => {
    expect(shouldProvision(base({ reccUrl: DEFAULT_RECC_URL }))).toBe(true);
  });

  it("tolerates a trailing slash on the configured default host", () => {
    expect(shouldProvision(base({ reccUrl: `${DEFAULT_RECC_URL}/` }))).toBe(true);
  });

  it("is false when the user has opted out", () => {
    expect(shouldProvision(base({ reccAutoSignup: false }))).toBe(false);
  });

  it("is true when reccAutoSignup is explicitly true", () => {
    expect(shouldProvision(base({ reccAutoSignup: true }))).toBe(true);
  });

  // config.json is hand-editable and this is the only field here whose absent
  // state means ON, so a junk value must fail safe towards NOT signing up. A
  // user who wrote "no" meant no. `as unknown as Config` because these are
  // exactly the values TypeScript would stop a caller writing — the point is
  // that a text editor does not typecheck.
  it.each([["no"], ["false"], [0], [null], [""], [1], ["yes"]])(
    "does not sign up when reccAutoSignup is the junk value %p",
    (value) => {
      const cfg = { ...base(), reccAutoSignup: value } as unknown as Config;
      expect(shouldProvision(cfg)).toBe(false);
    },
  );
});

async function tmpLock(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-provision-"));
  return path.join(dir, "recc-provision.lock");
}

/** A fetch that reports one anonymous signup and counts calls. */
function signupFetch(counter: { n: number }, body: unknown = { id: 1, name: "quiet-heron-4f2a", token: "tok123" }) {
  return (async () => {
    counter.n++;
    return { ok: true, status: 201, json: async () => body } as unknown as Response;
  }) as unknown as FetchImpl;
}

/** A config pair backed by a plain object, standing in for config.json. */
function fakeStore(initial: Config) {
  let current = initial;
  return {
    load: async () => ({ ...current }),
    save: async (c: Config) => { current = c; },
    get: () => current,
  };
}

describe("ensureReccAccount", () => {
  beforeEach(() => {
    vi.stubEnv("TORLINK_RECC_URL", "");
    vi.stubEnv("TORLINK_RECC_TOKEN", "");
  });

  it("signs up and writes url, token, name and claimed:false", async () => {
    const counter = { n: 0 };
    const store = fakeStore(base());
    await ensureReccAccount({
      fetchImpl: signupFetch(counter),
      lockFile: await tmpLock(),
      loadConfigImpl: store.load,
      saveConfigImpl: store.save,
    });
    expect(counter.n).toBe(1);
    expect(store.get().reccUrl).toBe(DEFAULT_RECC_URL);
    expect(store.get().reccToken).toBe("tok123");
    expect(store.get().reccAccountName).toBe("quiet-heron-4f2a");
    expect(store.get().reccAccountClaimed).toBe(false);
  });

  it("POSTs to /signup/anonymous with no auth header", async () => {
    let seenUrl = "";
    let seenInit: Record<string, unknown> = {};
    const impl = (async (url: string, init: Record<string, unknown>) => {
      seenUrl = String(url);
      seenInit = init;
      return { ok: true, status: 201, json: async () => ({ id: 1, name: "n", token: "t" }) } as unknown as Response;
    }) as unknown as FetchImpl;
    const store = fakeStore(base());
    await ensureReccAccount({
      fetchImpl: impl, lockFile: await tmpLock(), loadConfigImpl: store.load, saveConfigImpl: store.save,
    });
    expect(seenUrl).toBe(`${DEFAULT_RECC_URL}/signup/anonymous`);
    expect(seenInit.method).toBe("POST");
    expect(JSON.stringify(seenInit.headers ?? {})).not.toContain("authorization");
  });

  it("calls onProvisioned with the patch, so a caller's snapshot stays current", async () => {
    let patch: ProvisionedPatch | null = null;
    const store = fakeStore(base());
    await ensureReccAccount({
      fetchImpl: signupFetch({ n: 0 }), lockFile: await tmpLock(),
      loadConfigImpl: store.load, saveConfigImpl: store.save,
      onProvisioned: (p) => { patch = p; },
    });
    expect(patch).toEqual({
      reccUrl: DEFAULT_RECC_URL,
      reccToken: "tok123",
      reccAccountName: "quiet-heron-4f2a",
      reccAccountClaimed: false,
    });
  });

  // THE bug this guards: App.tsx's persistConfig writes the WHOLE config from
  // React state. Without onProvisioned, the next unrelated setting change
  // serialises a snapshot with no reccToken and deletes the account silently.
  it("gives the caller enough to keep a whole-config write from dropping the token", async () => {
    const store = fakeStore(base());
    let snapshot = base(); // stands in for App.tsx's React state
    await ensureReccAccount({
      fetchImpl: signupFetch({ n: 0 }), lockFile: await tmpLock(),
      loadConfigImpl: store.load, saveConfigImpl: store.save,
      onProvisioned: (p) => { snapshot = { ...snapshot, ...p }; },
    });
    await store.save({ ...snapshot, sort: "seeders" }); // a later unrelated change
    expect(store.get().reccToken).toBe("tok123");
  });

  it("makes no request at all when shouldProvision says no", async () => {
    const counter = { n: 0 };
    const store = fakeStore(base({ reccUrl: "http://192.168.0.98:4100" }));
    await ensureReccAccount({
      fetchImpl: signupFetch(counter), lockFile: await tmpLock(),
      loadConfigImpl: store.load, saveConfigImpl: store.save,
    });
    expect(counter.n).toBe(0);
    expect(store.get().reccToken).toBeUndefined();
  });

  it("makes exactly one request when reccUrl is already the default host", async () => {
    const counter = { n: 0 };
    const store = fakeStore(base({ reccUrl: DEFAULT_RECC_URL }));
    await ensureReccAccount({
      fetchImpl: signupFetch(counter), lockFile: await tmpLock(),
      loadConfigImpl: store.load, saveConfigImpl: store.save,
    });
    expect(counter.n).toBe(1);
  });

  // The two-process race the lock exists for.
  it("signs up once when two calls run concurrently against one lock file", async () => {
    const counter = { n: 0 };
    const lockFile = await tmpLock();
    const store = fakeStore(base());
    const slow = (async () => {
      counter.n++;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, status: 201, json: async () => ({ id: 1, name: "n", token: "tok123" }) } as unknown as Response;
    }) as unknown as FetchImpl;
    await Promise.all([
      ensureReccAccount({ fetchImpl: slow, lockFile, loadConfigImpl: store.load, saveConfigImpl: store.save }),
      ensureReccAccount({ fetchImpl: slow, lockFile, loadConfigImpl: store.load, saveConfigImpl: store.save }),
    ]);
    expect(counter.n).toBe(1);
  });

  it("releases the lock, so the next launch is not blocked forever", async () => {
    const lockFile = await tmpLock();
    const store = fakeStore(base());
    await ensureReccAccount({
      fetchImpl: signupFetch({ n: 0 }), lockFile, loadConfigImpl: store.load, saveConfigImpl: store.save,
    });
    await expect(fs.stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("takes over a stale lock older than 60s", async () => {
    const counter = { n: 0 };
    const lockFile = await tmpLock();
    await fs.writeFile(lockFile, "");
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lockFile, old, old);
    const store = fakeStore(base());
    await ensureReccAccount({
      fetchImpl: signupFetch(counter), lockFile, loadConfigImpl: store.load, saveConfigImpl: store.save,
    });
    expect(counter.n).toBe(1);
  });

  it("discards the new account when a token appeared during the request", async () => {
    const lockFile = await tmpLock();
    let current = base();
    const impl = (async () => {
      // Stands in for another process finishing first, mid-flight.
      current = { ...current, reccToken: "someone-elses", reccUrl: DEFAULT_RECC_URL };
      return { ok: true, status: 201, json: async () => ({ id: 2, name: "n2", token: "mine" }) } as unknown as Response;
    }) as unknown as FetchImpl;
    await ensureReccAccount({
      fetchImpl: impl, lockFile,
      loadConfigImpl: async () => ({ ...current }),
      saveConfigImpl: async (c) => { current = c; },
    });
    expect(current.reccToken).toBe("someone-elses");
  });

  // Spec §0: every one of these must RESOLVE, not reject.
  describe("fails soft — §0", () => {
    const cases: Array<[string, FetchImpl]> = [
      ["a thrown network error", (async () => { throw new Error("ENOTFOUND"); }) as unknown as FetchImpl],
      ["a 429", (async () => ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response) as unknown as FetchImpl],
      ["a 503", (async () => ({ ok: false, status: 503, json: async () => ({ error: "could not allocate a name" }) }) as unknown as Response) as unknown as FetchImpl],
      ["a body that is not JSON", (async () => ({ ok: true, status: 201, json: async () => { throw new Error("not json"); } }) as unknown as Response) as unknown as FetchImpl],
      ["a 201 with no token", (async () => ({ ok: true, status: 201, json: async () => ({ id: 1, name: "n" }) }) as unknown as Response) as unknown as FetchImpl],
      ["a 201 with a non-string token", (async () => ({ ok: true, status: 201, json: async () => ({ id: 1, name: "n", token: 42 }) }) as unknown as Response) as unknown as FetchImpl],
    ];

    for (const [label, impl] of cases) {
      it(`resolves and writes nothing on ${label}`, async () => {
        const store = fakeStore(base());
        await expect(
          ensureReccAccount({ fetchImpl: impl, lockFile: await tmpLock(), loadConfigImpl: store.load, saveConfigImpl: store.save }),
        ).resolves.toBeUndefined();
        expect(store.get().reccToken).toBeUndefined();
      });
    }

    it("resolves when saveConfig throws", async () => {
      await expect(
        ensureReccAccount({
          fetchImpl: signupFetch({ n: 0 }),
          lockFile: await tmpLock(),
          loadConfigImpl: async () => base(),
          saveConfigImpl: async () => { throw new Error("EROFS"); },
        }),
      ).resolves.toBeUndefined();
    });

    it("resolves when the lock cannot be created because its directory is missing", async () => {
      await expect(
        ensureReccAccount({
          fetchImpl: signupFetch({ n: 0 }),
          lockFile: "/nonexistent-dir-for-torlink-test/recc-provision.lock",
          loadConfigImpl: async () => base(),
          saveConfigImpl: async () => {},
        }),
      ).resolves.toBeUndefined();
    });

    it("resolves when loadConfig throws", async () => {
      await expect(
        ensureReccAccount({
          fetchImpl: signupFetch({ n: 0 }),
          lockFile: await tmpLock(),
          loadConfigImpl: async () => { throw new Error("EACCES"); },
          saveConfigImpl: async () => {},
        }),
      ).resolves.toBeUndefined();
    });

    it("abandons a hung request via the timeout rather than hanging the caller", async () => {
      const store = fakeStore(base());
      const hangs = (async (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as FetchImpl;
      await expect(
        ensureReccAccount({
          fetchImpl: hangs, timeoutMs: 20, lockFile: await tmpLock(),
          loadConfigImpl: store.load, saveConfigImpl: store.save,
        }),
      ).resolves.toBeUndefined();
      expect(store.get().reccToken).toBeUndefined();
    });
  });
});
