import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs, readFileSync } from "node:fs";
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

const tmpDirs: string[] = [];

async function tmpLock(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-provision-"));
  tmpDirs.push(dir);
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

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
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

  it("leaves a live lock in place and makes no request when another process holds it", async () => {
    const counter = { n: 0 };
    const lockFile = await tmpLock();
    await fs.writeFile(lockFile, ""); // a fresh lock: another process is mid-signup
    const store = fakeStore(base());
    await ensureReccAccount({
      fetchImpl: signupFetch(counter), lockFile,
      loadConfigImpl: store.load, saveConfigImpl: store.save,
    });
    expect(counter.n).toBe(0);
    // The holder's lock must survive — deleting it here is what would quietly
    // turn the lock into decoration while every other test still passed.
    await expect(fs.stat(lockFile)).resolves.toBeTruthy();
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

  it("does not clobber a self-hosted reccUrl set during the request", async () => {
    const lockFile = await tmpLock();
    let current = base();
    const impl = (async () => {
      // The user points reccUrl at their own reccd while we are in flight,
      // leaving the token blank — so the token check alone would not catch it.
      current = { ...current, reccUrl: "http://192.168.0.98:4100" };
      return { ok: true, status: 201, json: async () => ({ id: 2, name: "n2", token: "mine" }) } as unknown as Response;
    }) as unknown as FetchImpl;
    await ensureReccAccount({
      fetchImpl: impl, lockFile,
      loadConfigImpl: async () => ({ ...current }),
      saveConfigImpl: async (c) => { current = c; },
    });
    expect(current.reccUrl).toBe("http://192.168.0.98:4100");
    expect(current.reccToken).toBeUndefined();
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
      ["a 201 with a whitespace-only token", (async () => ({ ok: true, status: 201, json: async () => ({ id: 1, name: "n", token: "   " }) }) as unknown as Response) as unknown as FetchImpl],
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

    // The fresh-install path, and the regression guard for the bug this
    // replaced: configDir does not exist until something writes config, and
    // provisioning runs before anything does.
    it("creates the lock's directory and provisions when configDir does not exist yet", async () => {
      const counter = { n: 0 };
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-fresh-"));
      tmpDirs.push(parent);
      const lockFile = path.join(parent, "config", "recc-provision.lock");
      const store = fakeStore(base());
      await ensureReccAccount({
        fetchImpl: signupFetch(counter), lockFile,
        loadConfigImpl: store.load, saveConfigImpl: store.save,
      });
      expect(counter.n).toBe(1);
      expect(store.get().reccToken).toBe("tok123");
    });

    // §0 still needs a genuinely unusable lock path — one takeLock cannot rescue
    // by creating the parent, unlike the merely-missing directory above.
    //
    // A path *under a real file* is that, on every platform: mkdir refuses
    // (ENOTDIR or EEXIST) because a path component is not a directory. It has to
    // be a file this test creates, though. An earlier version used
    // `/dev/null/config/...`, reasoning that /dev/null is a file — which is true
    // on POSIX and false on Windows, where it is an ordinary unused path that
    // mkdir happily creates. Both Windows CI jobs failed on it: the lock was
    // taken, the signup went through, and a token was written.
    it("resolves and writes nothing when the lock path is genuinely unusable", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "torlink-provision-"));
      tmpDirs.push(dir);
      const notADirectory = path.join(dir, "occupied");
      await fs.writeFile(notADirectory, "");
      const store = fakeStore(base());
      await expect(
        ensureReccAccount({
          fetchImpl: signupFetch({ n: 0 }),
          lockFile: path.join(notADirectory, "config", "recc-provision.lock"),
          loadConfigImpl: store.load, saveConfigImpl: store.save,
        }),
      ).resolves.toBeUndefined();
      expect(store.get().reccToken).toBeUndefined();
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

    it("resolves when the config re-read after signup throws", async () => {
      let calls = 0;
      await expect(
        ensureReccAccount({
          fetchImpl: signupFetch({ n: 0 }),
          lockFile: await tmpLock(),
          loadConfigImpl: async () => {
            calls++;
            if (calls > 1) throw new Error("EACCES");
            return base();
          },
          saveConfigImpl: async () => {},
        }),
      ).resolves.toBeUndefined();
      expect(calls).toBe(2);
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

// Deliberately OUTSIDE the `shouldProvision`/`ensureReccAccount` describes
// above: both stub TORLINK_RECC_URL/TORLINK_RECC_TOKEN to "" in a beforeEach,
// which would hide the ambient guard entirely. This test runs with whatever
// the test environment sets by default — src/test-setup.ts points
// TORLINK_RECC_URL at a bogus non-default host precisely so no test anywhere
// in the suite can reach the real reccd, even one that forgets to mock
// "../recc/provision" outright (the App.web.test.tsx incident this task's
// brief describes). If that guard is ever removed, or shouldProvision's
// self-hosted-host check is loosened, this fails loudly instead of the whole
// suite silently starting to make real network calls.
it("the ambient test environment refuses to provision", () => {
  // Earlier describes in this file vi.stubEnv the recc env vars to "" and
  // never unstub — restore the real ambient value test-setup.ts set before
  // asserting on it, or this would just be checking the previous test's stub.
  vi.unstubAllEnvs();
  expect(shouldProvision(base())).toBe(false);
});

// §0's one requirement a unit test of this module cannot reach: the call sites
// must not await, and must carry their own catch. An unhandled rejection from a
// fire-and-forget reccd call is the exact hazard routes.ts documents, and an
// await would put reccd on torlink's startup path. deps-pin.test.ts sets the
// precedent for asserting on source shape.
describe("call sites", () => {
  const CALL_SITES = ["src/ui/App.tsx", "src/daemon/serve.ts"];

  for (const rel of CALL_SITES) {
    it(`${rel} calls ensureReccAccount fire-and-forget, with a catch`, () => {
      const source = readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
      expect(source).toContain("ensureReccAccount");
      // No `await ensureReccAccount` anywhere — that would put reccd on the
      // startup path.
      expect(source).not.toMatch(/await\s+ensureReccAccount/);
      // ONE regex spanning the whole call, deliberately: an earlier draft
      // sliced from `source.indexOf("ensureReccAccount(")` and asserted the
      // remainder contained ".catch(", which matched the import line first and
      // then found some unrelated `.catch(` hundreds of lines later. It passed
      // whatever the call site did. A vacuous assertion is worse than none —
      // the same trap CLAUDE.md records for `not.toContain` after a rename.
      // {0,600} covers App.tsx's multi-line onProvisioned callback.
      expect(source).toMatch(/void ensureReccAccount\([\s\S]{0,600}?\)\.catch\(/);
    });
  }
});
