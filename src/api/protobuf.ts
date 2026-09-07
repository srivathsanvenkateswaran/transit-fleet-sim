/**
 * A protobuf wire-format writer, small enough to read in one sitting.
 *
 * GTFS-Realtime is protobuf, and this repository has a hard rule that
 * `git clone && docker compose up` needs no network access. Vendoring a
 * protobuf runtime for the fourteen field types a `FeedMessage` actually uses
 * would add a dependency, a code-generation step and a `.proto` file to keep
 * in sync, to encode a message this service constructs itself and never
 * parses. So the encoder is here, hand-written against the wire format, and
 * `tests/api/gtfsRealtime.test.ts` decodes what it writes rather than
 * trusting it.
 *
 * Only the four wire types GTFS-Realtime uses are implemented: varint for
 * integers, bools and enums; length-delimited for strings and nested
 * messages; fixed32 for `float`; fixed64 for `double`. Signed zig-zag
 * encoding is deliberately absent, because no field in the feed is `sint*`.
 */

const VARINT = 0
const FIXED64 = 1
const LENGTH_DELIMITED = 2
const FIXED32 = 5

export class ProtobufWriter {
  #chunks: Uint8Array[] = []

  varint(field: number, value: number): this {
    if (value === 0) return this
    this.#tag(field, VARINT)
    this.#writeVarint(value)
    return this
  }

  /** Emits even when zero: some enum values are `0` and still meaningful. */
  enumValue(field: number, value: number): this {
    this.#tag(field, VARINT)
    this.#writeVarint(value)
    return this
  }

  bool(field: number, value: boolean): this {
    if (!value) return this
    this.#tag(field, VARINT)
    this.#writeVarint(1)
    return this
  }

  /**
   * A signed 32-bit field. Protobuf encodes a negative `int32` as a ten-byte
   * varint of its 64-bit two's complement, which is the one place the naive
   * "just write the number" approach is wrong - and `StopTimeEvent.delay` is
   * routinely negative.
   */
  int32(field: number, value: number): this {
    if (value === 0) return this
    this.#tag(field, VARINT)
    if (value < 0) this.#writeNegativeInt32(value)
    else this.#writeVarint(value)
    return this
  }

  string(field: number, value: string): this {
    if (value === '') return this
    const bytes = new TextEncoder().encode(value)
    this.#tag(field, LENGTH_DELIMITED)
    this.#writeVarint(bytes.length)
    this.#chunks.push(bytes)
    return this
  }

  float(field: number, value: number): this {
    this.#tag(field, FIXED32)
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setFloat32(0, value, true)
    this.#chunks.push(bytes)
    return this
  }

  double(field: number, value: number): this {
    this.#tag(field, FIXED64)
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setFloat64(0, value, true)
    this.#chunks.push(bytes)
    return this
  }

  message(field: number, build: (writer: ProtobufWriter) => void): this {
    const nested = new ProtobufWriter()
    build(nested)
    const bytes = nested.finish()
    this.#tag(field, LENGTH_DELIMITED)
    this.#writeVarint(bytes.length)
    this.#chunks.push(bytes)
    return this
  }

  finish(): Uint8Array {
    const total = this.#chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const output = new Uint8Array(total)
    let offset = 0
    for (const chunk of this.#chunks) {
      output.set(chunk, offset)
      offset += chunk.length
    }
    return output
  }

  #tag(field: number, wireType: number): void {
    this.#writeVarint(field * 8 + wireType)
  }

  #writeVarint(value: number): void {
    const bytes: number[] = []
    let remaining = Math.floor(value)
    do {
      let byte = remaining % 128
      remaining = Math.floor(remaining / 128)
      if (remaining > 0) byte += 128
      bytes.push(byte)
    } while (remaining > 0)
    this.#chunks.push(Uint8Array.from(bytes))
  }

  #writeNegativeInt32(value: number): void {
    let remaining = BigInt.asUintN(64, BigInt(Math.trunc(value)))
    const bytes: number[] = []
    do {
      let byte = Number(remaining & 0x7fn)
      remaining >>= 7n
      if (remaining > 0n) byte |= 0x80
      bytes.push(byte)
    } while (remaining > 0n)
    this.#chunks.push(Uint8Array.from(bytes))
  }
}
