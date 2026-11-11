import { describe, expect, it, vi } from "vitest";
import { WORDPRESS_CREDENTIAL_CHANNELS } from "../shared/wordpress-credential-channels.js";
import { createWordPressCredentialHandlers } from "./wordpress-credential-ipc.js";
import { WordPressCredentialVaultError, type WordPressCredentialVault } from "./wordpress-credential-vault.js";

describe("private WordPress credential IPC", () => {
  it("returns only configuration status and acknowledges writes without returning secrets", async () => {
    const vault = {
      status: vi.fn(async () => ({ state: "configured" as const })),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      getForHost: vi.fn(async () => ({ username: "fictional-user", applicationPassword: "fictional-secret" })),
    } as unknown as WordPressCredentialVault;
    const handlers = createWordPressCredentialHandlers({ vault, isTrustedSender: (sender) => sender === "app-window" });
    const event = { sender: "app-window" };
    const status = await handlers.get(WORDPRESS_CREDENTIAL_CHANNELS.status)!(event, "https://fictional.example");
    const saved = await handlers.get(WORDPRESS_CREDENTIAL_CHANNELS.save)!(event, {
      siteUrl: "https://fictional.example",
      username: "fictional-user",
      applicationPassword: "fictional-secret",
    });

    expect(status).toEqual({ state: "configured" });
    expect(saved).toBeUndefined();
    expect(JSON.stringify([status, saved])).not.toContain("fictional-user");
    expect(JSON.stringify([status, saved])).not.toContain("fictional-secret");
    expect(vault.getForHost).not.toHaveBeenCalled();
  });

  it("rejects untrusted windows with a generic error and does not call the vault", async () => {
    const vault = {
      status: vi.fn(async () => ({ state: "configured" as const })),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    } as unknown as WordPressCredentialVault;
    const handlers = createWordPressCredentialHandlers({ vault, isTrustedSender: () => false });

    await expect(
      handlers.get(WORDPRESS_CREDENTIAL_CHANNELS.save)!(
        { sender: "external-window" },
        {
          siteUrl: "https://fictional.example",
          username: "fictional-user",
          applicationPassword: "fictional-secret",
        },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("__SITEINDEX_IPC_ERROR__:") });
    expect(vault.save).not.toHaveBeenCalled();
  });

  it("does not echo invalid credential values in IPC errors", async () => {
    const vault = {
      status: vi.fn(),
      save: vi.fn(async () => {
        throw new WordPressCredentialVaultError("INVALID_INPUT");
      }),
      clear: vi.fn(),
    } as unknown as WordPressCredentialVault;
    const handlers = createWordPressCredentialHandlers({ vault, isTrustedSender: () => true });
    let errorMessage = "";
    try {
      await handlers.get(WORDPRESS_CREDENTIAL_CHANNELS.save)!(
        { sender: "app-window" },
        {
          siteUrl: "javascript:fictional-secret",
          username: "fictional-user",
          applicationPassword: "fictional-secret",
        },
      );
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain("__SITEINDEX_IPC_ERROR__:");
    expect(errorMessage).not.toContain("fictional-user");
    expect(errorMessage).not.toContain("fictional-secret");
    expect(vault.save).toHaveBeenCalledOnce();
  });
});
