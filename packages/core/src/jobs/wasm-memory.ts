const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00] as const;

interface DecodedLeb128 {
  value: number;
  next: number;
}

function readU32Leb(bytes: Uint8Array, offset: number, end: number): DecodedLeb128 {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < 5; index += 1) {
    if (offset >= end) throw new Error("Truncated WebAssembly LEB128 value.");
    const byte = bytes[offset]!;
    offset += 1;
    if (index === 4 && (byte & 0xf0) !== 0) throw new Error("WebAssembly LEB128 value exceeds u32.");
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: offset };
    shift += 7;
  }
  throw new Error("Malformed WebAssembly LEB128 value.");
}

function encodeU32Leb(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("WebAssembly memory limit is outside u32 range.");
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return bytes;
}

/**
 * Clamp a module's single, defined memory to a finite byte limit before compile.
 * Modules with imported/multiple/64-bit/shared memories are intentionally rejected;
 * callers must not run them without proving an equivalent bound.
 */
export function capWasmMemory(bytes: Uint8Array, maximumBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes % 65_536 !== 0) {
    throw new Error("WebAssembly memory cap must be a positive 64 KiB multiple.");
  }
  if (bytes.length < WASM_HEADER.length || !WASM_HEADER.every((byte, index) => bytes[index] === byte)) {
    throw new Error("Invalid WebAssembly module header.");
  }

  const maximumPages = maximumBytes / 65_536;
  const chunks: Buffer[] = [Buffer.from(WASM_HEADER)];
  let offset: number = WASM_HEADER.length;
  let memorySections = 0;

  while (offset < bytes.length) {
    const sectionStart = offset;
    const sectionId = bytes[offset]!;
    offset += 1;
    const sectionLength = readU32Leb(bytes, offset, bytes.length);
    const payloadStart = sectionLength.next;
    const sectionEnd = payloadStart + sectionLength.value;
    if (!Number.isSafeInteger(sectionEnd) || sectionEnd > bytes.length) {
      throw new Error("Truncated WebAssembly section.");
    }

    if (sectionId !== 5) {
      chunks.push(Buffer.from(bytes.subarray(sectionStart, sectionEnd)));
      offset = sectionEnd;
      continue;
    }

    memorySections += 1;
    if (memorySections !== 1) throw new Error("Multiple WebAssembly memory sections are unsupported.");
    let cursor = payloadStart;
    const count = readU32Leb(bytes, cursor, sectionEnd);
    cursor = count.next;
    if (count.value !== 1) throw new Error("Expected one defined WebAssembly memory.");

    const flags = readU32Leb(bytes, cursor, sectionEnd);
    cursor = flags.next;
    if (flags.value !== 0 && flags.value !== 1) {
      throw new Error("Imported, shared, or memory64 WebAssembly limits are unsupported.");
    }
    const minimum = readU32Leb(bytes, cursor, sectionEnd);
    cursor = minimum.next;
    let declaredMaximum = maximumPages;
    if (flags.value === 1) {
      const maximum = readU32Leb(bytes, cursor, sectionEnd);
      cursor = maximum.next;
      declaredMaximum = maximum.value;
    }
    if (cursor !== sectionEnd || minimum.value > declaredMaximum || minimum.value > maximumPages) {
      throw new Error("WebAssembly memory limits cannot fit within the configured cap.");
    }

    const cappedMaximum = Math.min(declaredMaximum, maximumPages);
    const memoryPayload = [
      ...encodeU32Leb(1), // one defined memory
      1, // has a maximum; threads and memory64 are not enabled
      ...encodeU32Leb(minimum.value),
      ...encodeU32Leb(cappedMaximum),
    ];
    chunks.push(Buffer.from([sectionId, ...encodeU32Leb(memoryPayload.length), ...memoryPayload]));
    offset = sectionEnd;
  }

  if (memorySections !== 1) throw new Error("WebAssembly module has no bounded defined memory.");
  return Buffer.concat(chunks);
}
