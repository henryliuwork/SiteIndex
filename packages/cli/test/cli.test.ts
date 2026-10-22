import { describe, expect, it } from "vitest";
import { main } from "../src";

const io = () => {
  const lines: string[] = [];
  return { lines, io: { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s) } };
};

describe("cli skeleton", () => {
  it("prints help", async () => {
    const t = io();
    expect(await main([], t.io)).toBe(0);
    expect(t.lines[0]).toContain("siteindex");
  });
  it("rejects unknown commands with exit 6", async () => {
    expect(await main(["nope"], io().io)).toBe(6);
  });
});
