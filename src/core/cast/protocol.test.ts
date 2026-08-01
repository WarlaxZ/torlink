import { describe, expect, it } from "vitest";
import {
  FrameReader,
  MAX_FRAME_BYTES,
  decodeCastMessage,
  encodeCastMessage,
  frameCastMessage,
  type CastMessage,
} from "./protocol";

const MSG: CastMessage = {
  sourceId: "sender-torlink",
  destinationId: "receiver-0",
  namespace: "urn:x-cast:com.google.cast.receiver",
  payload: JSON.stringify({ type: "LAUNCH", appId: "CC1AD845", requestId: 1 }),
};

describe("encodeCastMessage / decodeCastMessage", () => {
  it("round-trips every field", () => {
    expect(decodeCastMessage(encodeCastMessage(MSG))).toEqual(MSG);
  });

  it("round-trips a payload carrying non-ASCII, so the length prefix is bytes and not characters", () => {
    const msg = { ...MSG, payload: JSON.stringify({ title: "Kestrel — 2010" }) };
    expect(decodeCastMessage(encodeCastMessage(msg))).toEqual(msg);
  });

  it("ignores a field it does not know rather than throwing", () => {
    // field 7, wire type 0 (varint), value 3 — appended to a valid body.
    const extended = Buffer.concat([encodeCastMessage(MSG), Buffer.from([0x38, 0x03])]);
    expect(decodeCastMessage(extended)).toEqual(MSG);
  });
});

describe("FrameReader", () => {
  it("yields one message from a whole frame", () => {
    const reader = new FrameReader();
    expect(reader.push(frameCastMessage(MSG))).toEqual([MSG]);
  });

  it("yields nothing until a frame whose length prefix is split across chunks completes", () => {
    const reader = new FrameReader();
    const framed = frameCastMessage(MSG);
    // Two bytes of the four-byte length: the failure mode every hand-rolled
    // framer has on its first day.
    expect(reader.push(framed.subarray(0, 2))).toEqual([]);
    expect(reader.push(framed.subarray(2, 9))).toEqual([]);
    expect(reader.push(framed.subarray(9))).toEqual([MSG]);
  });

  it("yields two messages from one chunk carrying both", () => {
    const reader = new FrameReader();
    const second = { ...MSG, payload: JSON.stringify({ type: "PONG" }) };
    const chunk = Buffer.concat([frameCastMessage(MSG), frameCastMessage(second)]);
    expect(reader.push(chunk)).toEqual([MSG, second]);
  });

  it("refuses a frame claiming an absurd length instead of buffering for it", () => {
    const reader = new FrameReader();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => reader.push(header)).toThrow(/refused/);
  });
});
