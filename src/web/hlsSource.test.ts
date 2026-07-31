import { describe, expect, it } from "vitest";
import { makeResolveHls } from "./hlsSource";
import type { DebridProvider } from "../integrations/debrid/types";
import type { StreamSession } from "../core/streamSession";

const MANIFEST = "https://4.stream.real-debrid.example/t/ID20/eng1/none/aac/full.m3u8";

const session = (over: Partial<StreamSession> = {}): StreamSession =>
  ({
    id: "sid-1",
    capability: "cap-1",
    backendHandle: null,
    backend: "debrid",
    provider: "realdebrid",
    name: "Kestrel.2010.1080p.BluRay.x264-GROUP",
    state: "ready",
    files: [
      {
        url: "https://cdn.example/x",
        filename: "Kestrel.2010.1080p.BluRay.x264.mkv",
        bytes: 1,
        providerFileId: "ABCD",
        providerStreamable: true,
      },
    ],
    progress: 100,
    createdAt: 0,
    ...over,
  }) as StreamSession;

// Only the parts makeResolveHls touches; the rest of DebridProvider is not its
// business and a full fake would just be noise that drifts.
const provider = (over: Partial<DebridProvider> = {}): DebridProvider =>
  ({ transcodeManifest: async () => MANIFEST, ...over }) as DebridProvider;

const deps = (over: Parameters<typeof makeResolveHls>[0] = {}) => ({
  tokenImpl: async () => "tok",
  providerImpl: () => provider(),
  ...over,
});

describe("makeResolveHls", () => {
  it("returns the manifest when everything is in place", async () => {
    const resolve = makeResolveHls(deps());
    expect(await resolve(session(), 0)).toBe(MANIFEST);
  });

  it("returns null for a torrent-backed session — there is no provider to ask", async () => {
    const resolve = makeResolveHls(deps());
    expect(await resolve(session({ backend: "torrent", provider: undefined }), 0)).toBeNull();
  });

  it("returns null when the file has no provider id", async () => {
    const resolve = makeResolveHls(deps());
    const s = session({
      files: [{ url: "https://cdn.example/x", filename: "Kestrel.mkv", bytes: 1 }],
    });
    expect(await resolve(s, 0)).toBeNull();
  });

  it("returns null when the provider says the file is not streamable", async () => {
    // The endpoint answers 200 with manifest URLs even for these, and the URLs
    // then 404 with invalid_duration. Offering one would show the browser a
    // load failure instead of the honest card.
    const resolve = makeResolveHls(deps());
    const s = session({
      files: [
        {
          url: "https://cdn.example/x",
          filename: "Kestrel.rar",
          bytes: 1,
          providerFileId: "ABCD",
          providerStreamable: false,
        },
      ],
    });
    expect(await resolve(s, 0)).toBeNull();
  });

  it("does not call the provider at all when the file is not streamable", async () => {
    let called = 0;
    const resolve = makeResolveHls(
      deps({
        providerImpl: () =>
          provider({
            transcodeManifest: async () => {
              called += 1;
              return MANIFEST;
            },
          }),
      }),
    );
    const s = session({
      files: [
        {
          url: "https://cdn.example/x",
          filename: "Kestrel.rar",
          bytes: 1,
          providerFileId: "ABCD",
          providerStreamable: false,
        },
      ],
    });
    await resolve(s, 0);
    expect(called).toBe(0);
  });

  it("proceeds when streamable is undefined — the provider simply did not say", async () => {
    const resolve = makeResolveHls(deps());
    const s = session({
      files: [
        {
          url: "https://cdn.example/x",
          filename: "Kestrel.mkv",
          bytes: 1,
          providerFileId: "ABCD",
        },
      ],
    });
    expect(await resolve(s, 0)).toBe(MANIFEST);
  });

  it("returns null when the provider does not do transcoding", async () => {
    const resolve = makeResolveHls(deps({ providerImpl: () => ({}) as DebridProvider }));
    expect(await resolve(session(), 0)).toBeNull();
  });

  it("returns null when there is no configured token", async () => {
    const resolve = makeResolveHls(deps({ tokenImpl: async () => null }));
    expect(await resolve(session(), 0)).toBeNull();
  });

  it("returns null rather than throwing when the provider call fails", async () => {
    const resolve = makeResolveHls(
      deps({
        providerImpl: () =>
          provider({
            transcodeManifest: async () => {
              throw new Error("network");
            },
          }),
      }),
    );
    expect(await resolve(session(), 0)).toBeNull();
  });

  it("returns null rather than throwing when reading the token fails", async () => {
    const resolve = makeResolveHls(
      deps({
        tokenImpl: async () => {
          throw new Error("config unreadable");
        },
      }),
    );
    expect(await resolve(session(), 0)).toBeNull();
  });

  it("returns null for an index that is not in the file list", async () => {
    const resolve = makeResolveHls(deps());
    expect(await resolve(session(), 99)).toBeNull();
  });

  it("asks for the token of the SESSION's provider, not whichever is active now", async () => {
    // A user can switch providers while a session is live. Using the active
    // provider's token would send a TorBox key to Real-Debrid.
    const asked: string[] = [];
    const resolve = makeResolveHls(
      deps({
        tokenImpl: async (p) => {
          asked.push(p);
          return "tok";
        },
      }),
    );
    await resolve(session({ provider: "torbox" }), 0);
    expect(asked).toEqual(["torbox"]);
  });
});
