import { describe, expect, it } from "vitest";
import { createContentMock } from "../content";

describe("content mock", () => {
  it("keeps the shared drafts contract but returns no UI-managed drafts", async () => {
    await expect(createContentMock().listDrafts("kingsyard")).resolves.toEqual([]);
  });
});
