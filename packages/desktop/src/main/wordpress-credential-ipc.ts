import { serializeIpcError } from "./ipc-registry.js";
import { WordPressCredentialVaultError, type WordPressCredentialVault } from "./wordpress-credential-vault.js";
import { WORDPRESS_CREDENTIAL_CHANNELS } from "../shared/wordpress-credential-channels.js";
import type { WordPressCredentialInput } from "../shared/wordpress-credential-types.js";

export interface WordPressCredentialInvokeEvent {
  sender: unknown;
}

export type WordPressCredentialHandler = (
  event: WordPressCredentialInvokeEvent,
  ...args: unknown[]
) => Promise<unknown>;

export interface WordPressCredentialIpcDependencies {
  vault: WordPressCredentialVault;
  isTrustedSender(sender: unknown): boolean;
}

function invalidInput(): Error {
  return serializeIpcError({ code: "CONFIG_INVALID", message: "WordPress 凭据输入无效。" });
}

function storageError(error: unknown): Error {
  if (error instanceof WordPressCredentialVaultError && error.code === "INVALID_INPUT") return invalidInput();
  return serializeIpcError({ code: "WRITE_FAILED", message: "本机安全存储不可用或凭据需要重新输入。" });
}

function isCredentialInput(value: unknown): value is WordPressCredentialInput {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "siteUrl" in value &&
    typeof value.siteUrl === "string" &&
    "username" in value &&
    typeof value.username === "string" &&
    "applicationPassword" in value &&
    typeof value.applicationPassword === "string"
  );
}

function isHost(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2048;
}

export function createWordPressCredentialHandlers(
  dependencies: WordPressCredentialIpcDependencies,
): ReadonlyMap<string, WordPressCredentialHandler> {
  const invoke = async (event: WordPressCredentialInvokeEvent, operation: () => Promise<unknown>): Promise<unknown> => {
    if (!dependencies.isTrustedSender(event.sender)) {
      throw serializeIpcError({ code: "CONFIG_INVALID", message: "不允许此窗口访问凭据存储。" });
    }
    try {
      return await operation();
    } catch (error) {
      throw storageError(error);
    }
  };

  return new Map([
    [
      WORDPRESS_CREDENTIAL_CHANNELS.status,
      (event, siteUrl) => {
        if (!isHost(siteUrl)) throw invalidInput();
        return invoke(event, () => dependencies.vault.status(siteUrl));
      },
    ],
    [
      WORDPRESS_CREDENTIAL_CHANNELS.save,
      (event, input) => {
        if (!isCredentialInput(input)) throw invalidInput();
        return invoke(event, () => dependencies.vault.save(input));
      },
    ],
    [
      WORDPRESS_CREDENTIAL_CHANNELS.clear,
      (event, siteUrl) => {
        if (!isHost(siteUrl)) throw invalidInput();
        return invoke(event, () => dependencies.vault.clear(siteUrl));
      },
    ],
  ]);
}

export function registerWordPressCredentialHandlers(
  handle: (channel: string, listener: WordPressCredentialHandler) => void,
  dependencies: WordPressCredentialIpcDependencies,
): void {
  for (const [channel, listener] of createWordPressCredentialHandlers(dependencies)) handle(channel, listener);
}
