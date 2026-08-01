/**
 * The CASTV2 wire format, by hand.
 *
 * A `CastMessage` is a protobuf with six fields and its shape never varies:
 * protocol_version (1, varint), source_id (2), destination_id (3), namespace
 * (4), payload_type (5, varint) and payload_utf8 (6). Everything torlink sends
 * or reads is JSON in field 6; the binary payload field is never used.
 *
 * Sixty lines of encoder is why `protobufjs` is not a dependency here: it is
 * roughly a megabyte into the bundled CLI, whose whole runtime dependency list
 * is eleven packages, to encode a message with no variability at all.
 */

export interface CastMessage {
  sourceId: string;
  destinationId: string;
  namespace: string;
  /** The JSON body. Field 6, `payload_utf8`. */
  payload: string;
}

/**
 * The largest frame we will assemble.
 *
 * A cast reply is a small JSON object; the biggest thing a receiver sends is a
 * MEDIA_STATUS with track metadata, orders of magnitude under this. The cap
 * exists because the length prefix arrives from the network: without it, four
 * bytes from anything listening on port 8009 can make this buffer without
 * bound.
 */
export const MAX_FRAME_BYTES = 1 << 20;

function varint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return Buffer.from(out);
}

// Wire type 0 is a varint, 2 is length-delimited. Those are the only two here.
function key(field: number, wire: 0 | 2): Buffer {
  return varint((field << 3) | wire);
}

function stringField(field: number, value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([key(field, 2), varint(bytes.length), bytes]);
}

export function encodeCastMessage(m: CastMessage): Buffer {
  return Buffer.concat([
    key(1, 0),
    varint(0), // protocol_version = CASTV2_1_0
    stringField(2, m.sourceId),
    stringField(3, m.destinationId),
    stringField(4, m.namespace),
    key(5, 0),
    varint(0), // payload_type = STRING
    stringField(6, m.payload),
  ]);
}

function readVarint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  // Multiplication rather than `<<`, which is a 32-bit operation in JS and
  // would silently wrap on a five-byte varint.
  let shift = 1;
  let i = at;
  for (;;) {
    if (i >= buf.length) throw new Error("cast frame: truncated varint");
    const byte = buf[i]!;
    i += 1;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) break;
    shift *= 128;
    if (shift > 2 ** 42) throw new Error("cast frame: varint too long");
  }
  return { value, next: i };
}

/**
 * Read a body into the four fields that matter.
 *
 * Unknown fields are skipped rather than rejected: a future receiver adding one
 * must not stop playback, and the two enum fields we write are skipped by this
 * same path on the way back in.
 */
export function decodeCastMessage(body: Buffer): CastMessage {
  const out: CastMessage = { sourceId: "", destinationId: "", namespace: "", payload: "" };
  let at = 0;
  while (at < body.length) {
    const k = readVarint(body, at);
    at = k.next;
    const field = Math.floor(k.value / 8);
    const wire = k.value % 8;
    if (wire === 0) {
      at = readVarint(body, at).next;
      continue;
    }
    if (wire !== 2) throw new Error(`cast frame: unsupported wire type ${wire}`);
    const len = readVarint(body, at);
    at = len.next;
    const end = at + len.value;
    if (end > body.length) throw new Error("cast frame: truncated field");
    const text = body.subarray(at, end).toString("utf8");
    at = end;
    if (field === 2) out.sourceId = text;
    else if (field === 3) out.destinationId = text;
    else if (field === 4) out.namespace = text;
    else if (field === 6) out.payload = text;
  }
  return out;
}

export function frameCastMessage(m: CastMessage): Buffer {
  const body = encodeCastMessage(m);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Reassemble frames from a TCP stream.
 *
 * Stateful on purpose: a socket hands over arbitrary chunk boundaries, so a
 * length prefix split across two reads is normal traffic and not an error.
 */
export class FrameReader {
  // `ArrayBufferLike` rather than the narrower default: `subarray` returns a
  // view whose backing buffer type is unconstrained, and this field is
  // reassigned from one on every complete frame.
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): CastMessage[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const out: CastMessage[] = [];
    for (;;) {
      if (this.buffered.length < 4) break;
      const length = this.buffered.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`cast frame of ${length} bytes refused`);
      }
      if (this.buffered.length < 4 + length) break;
      out.push(decodeCastMessage(this.buffered.subarray(4, 4 + length)));
      this.buffered = this.buffered.subarray(4 + length);
    }
    return out;
  }
}
