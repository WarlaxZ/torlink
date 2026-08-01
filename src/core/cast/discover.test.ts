import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CAST_PORT,
  devicesFromPackets,
  discover,
  parseManualDevice,
  type MdnsLike,
  type MdnsPacket,
} from "./discover";

// One device's answer, as multicast-dns reports it: a PTR naming the instance,
// an SRV with host and port, TXT key=value pairs as Buffers, and an A record.
function packetFor(opts: {
  instance: string;
  target: string;
  ip: string;
  port?: number;
  txt?: string[];
  withSrv?: boolean;
}): MdnsPacket {
  const records = [
    { name: "_googlecast._tcp.local", type: "PTR", data: opts.instance },
    ...(opts.withSrv === false
      ? []
      : [
          {
            name: opts.instance,
            type: "SRV",
            data: { port: opts.port ?? DEFAULT_CAST_PORT, target: opts.target },
          },
        ]),
    {
      name: opts.instance,
      type: "TXT",
      data: (opts.txt ?? ["id=abc123", "fn=Living Room TV", "md=Chromecast"]).map((s) =>
        Buffer.from(s),
      ),
    },
    { name: opts.target, type: "A", data: opts.ip },
  ];
  return { answers: records, additionals: [] };
}

describe("devicesFromPackets", () => {
  it("builds a device from SRV, A and TXT", () => {
    const devices = devicesFromPackets([
      packetFor({ instance: "abc._googlecast._tcp.local", target: "abc.local", ip: "192.168.0.40" }),
    ]);
    expect(devices).toEqual([
      { id: "abc123", name: "Living Room TV", model: "Chromecast", host: "192.168.0.40", port: 8009 },
    ]);
  });

  it("drops an answer with no SRV rather than half-building a device with no port", () => {
    const devices = devicesFromPackets([
      packetFor({
        instance: "abc._googlecast._tcp.local",
        target: "abc.local",
        ip: "192.168.0.40",
        withSrv: false,
      }),
    ]);
    expect(devices).toEqual([]);
  });

  it("collapses the same device answering on two interfaces, by id", () => {
    const one = packetFor({
      instance: "abc._googlecast._tcp.local",
      target: "abc.local",
      ip: "192.168.0.40",
    });
    const again = packetFor({
      instance: "abc._googlecast._tcp.local",
      target: "abc.local",
      ip: "10.8.0.4",
    });
    expect(devicesFromPackets([one, again]).map((d) => d.id)).toEqual(["abc123"]);
  });

  it("falls back to the instance name when TXT carries no fn, so a device is never nameless", () => {
    const devices = devicesFromPackets([
      packetFor({
        instance: "kitchen-display._googlecast._tcp.local",
        target: "k.local",
        ip: "192.168.0.41",
        txt: ["id=k1"],
      }),
    ]);
    expect(devices[0]).toMatchObject({ id: "k1", name: "kitchen-display", model: "" });
  });

  it("keeps two genuinely different devices", () => {
    const devices = devicesFromPackets([
      packetFor({ instance: "a._googlecast._tcp.local", target: "a.local", ip: "192.168.0.40" }),
      packetFor({
        instance: "b._googlecast._tcp.local",
        target: "b.local",
        ip: "192.168.0.41",
        txt: ["id=k1", "fn=Kitchen display", "md=Google TV Streamer"],
      }),
    ]);
    expect(devices.map((d) => d.name)).toEqual(["Living Room TV", "Kitchen display"]);
  });
});

describe("parseManualDevice", () => {
  it("takes a bare host and defaults the port", () => {
    expect(parseManualDevice("192.168.0.40")).toEqual({
      id: "manual:192.168.0.40:8009",
      name: "192.168.0.40",
      model: "",
      host: "192.168.0.40",
      port: 8009,
    });
  });

  it("takes host:port", () => {
    expect(parseManualDevice("tv.local:8010")).toMatchObject({ host: "tv.local", port: 8010 });
  });

  it("is null for absent, blank, or an unusable port", () => {
    expect(parseManualDevice(undefined)).toBeNull();
    expect(parseManualDevice("   ")).toBeNull();
    expect(parseManualDevice("tv.local:not-a-port")).toBeNull();
    expect(parseManualDevice("tv.local:0")).toBeNull();
  });
});

describe("discover", () => {
  it("queries the cast service, collects what answers within the window, and destroys the socket", async () => {
    const handlers: ((p: MdnsPacket) => void)[] = [];
    const query = vi.fn();
    const destroy = vi.fn();
    const mdns: MdnsLike = {
      on: (_event, cb) => {
        handlers.push(cb);
      },
      query,
      destroy,
    };
    const devices = await discover({
      mdnsFactory: () => mdns,
      timeoutMs: 1,
      sleep: async () => {
        handlers[0]!(
          packetFor({
            instance: "abc._googlecast._tcp.local",
            target: "abc.local",
            ip: "192.168.0.40",
          }),
        );
      },
    });
    expect(query).toHaveBeenCalledWith({
      questions: [{ name: "_googlecast._tcp.local", type: "PTR" }],
    });
    expect(devices.map((d) => d.name)).toEqual(["Living Room TV"]);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("resolves empty when nothing answers, rather than throwing or hanging", async () => {
    const mdns: MdnsLike = { on: () => {}, query: () => {}, destroy: () => {} };
    await expect(
      discover({ mdnsFactory: () => mdns, timeoutMs: 1, sleep: async () => {} }),
    ).resolves.toEqual([]);
  });

  it("destroys the socket even when the query itself throws", async () => {
    const destroy = vi.fn();
    const mdns: MdnsLike = {
      on: () => {},
      query: () => {
        throw new Error("no multicast route");
      },
      destroy,
    };
    await expect(
      discover({ mdnsFactory: () => mdns, timeoutMs: 1, sleep: async () => {} }),
    ).resolves.toEqual([]);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
