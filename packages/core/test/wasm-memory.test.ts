import { describe, expect, it } from "vitest";
import { capWasmMemory } from "../src/jobs/wasm-memory";

const HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function leb(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return bytes;
}

function moduleWithMemory(minimum: number, maximum?: number): Buffer {
  const limits = maximum === undefined
    ? [0, ...leb(minimum)]
    : [1, ...leb(minimum), ...leb(maximum)];
  const memoryPayload = Buffer.from([1, ...limits]);
  const memorySection = Buffer.from([5, memoryPayload.length, ...memoryPayload]);
  const exportPayload = Buffer.from([1, 1, 0x6d, 2, 0]); // export memory index 0 as "m"
  const exportSection = Buffer.from([7, exportPayload.length, ...exportPayload]);
  return Buffer.concat([HEADER, memorySection, exportSection]);
}

describe("capWasmMemory", () => {
  it("clamps a large declared maximum and enforces it at runtime", () => {
    const limitBytes = 3 * 65_536;
    const bytes = capWasmMemory(moduleWithMemory(1, 10_000), limitBytes);
    const module = new WebAssembly.Module(Uint8Array.from(bytes).buffer);
    const instance = new WebAssembly.Instance(module);
    const memory = instance.exports.m;
    expect(memory).toBeInstanceOf(WebAssembly.Memory);
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("Memory export missing.");

    expect(memory.grow(2)).toBe(1);
    expect(memory.buffer.byteLength).toBe(limitBytes);
    expect(() => memory.grow(1)).toThrow();
  });

  it("adds a finite maximum when the source module has none", () => {
    const limitBytes = 4 * 65_536;
    const module = new WebAssembly.Module(Uint8Array.from(capWasmMemory(moduleWithMemory(1), limitBytes)).buffer);
    const instance = new WebAssembly.Instance(module);
    const memory = instance.exports.m;
    expect(memory).toBeInstanceOf(WebAssembly.Memory);
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("Memory export missing.");

    expect(memory.grow(3)).toBe(1);
    expect(() => memory.grow(1)).toThrow();
  });

  it("fails closed when the module memory cannot fit the cap", () => {
    expect(() => capWasmMemory(moduleWithMemory(4), 3 * 65_536)).toThrow(/cannot fit/u);
    expect(() => capWasmMemory(HEADER, 3 * 65_536)).toThrow(/no bounded/u);
    expect(() => capWasmMemory(moduleWithMemory(1, 2), 65_537)).toThrow(/64 KiB/u);
  });
});
