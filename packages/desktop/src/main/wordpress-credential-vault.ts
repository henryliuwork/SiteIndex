import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  WordPressCredential,
  WordPressCredentialInput,
  WordPressCredentialStatus,
} from "../shared/wordpress-credential-types.js";

const VAULT_FILE_PREFIX = "wordpress-";
const VAULT_FILE_SUFFIX = ".vault.json";
const VAULT_FORMAT_VERSION = 1;

export interface SafeStorageAdapter {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export interface WordPressCredentialVaultOptions {
  platform: NodeJS.Platform;
  localAppData?: string;
  homeDirectory: string;
  safeStorage: SafeStorageAdapter;
  /** Test-only path override; production always resolves a platform-local directory. */
  directoryOverride?: string;
}

export class WordPressCredentialVaultError extends Error {
  constructor(
    readonly code:
      | "UNSUPPORTED_PLATFORM"
      | "LOCAL_STORAGE_UNAVAILABLE"
      | "ENCRYPTION_UNAVAILABLE"
      | "NEEDS_REENTRY"
      | "INVALID_INPUT",
  ) {
    super("WordPress 本机凭据无法安全读取或保存。");
    this.name = "WordPressCredentialVaultError";
  }
}

/**
 * Resolve a machine-local directory. Windows must have LOCALAPPDATA; falling back
 * to Electron's appData would put the vault in roaming AppData. macOS uses the
 * user's Library/Application Support, outside the Desktop/Documents iCloud scope.
 */
export function resolveWordPressCredentialDirectory(
  options: Pick<WordPressCredentialVaultOptions, "platform" | "localAppData" | "homeDirectory">,
): string {
  if (options.platform === "win32") {
    const localAppData = options.localAppData?.trim();
    if (!localAppData || !path.win32.isAbsolute(localAppData) || localAppData.startsWith("\\\\")) {
      throw new WordPressCredentialVaultError("LOCAL_STORAGE_UNAVAILABLE");
    }
    return path.win32.join(localAppData, "SiteIndex", "LocalCredentials");
  }

  if (options.platform === "darwin") {
    if (!path.posix.isAbsolute(options.homeDirectory)) {
      throw new WordPressCredentialVaultError("LOCAL_STORAGE_UNAVAILABLE");
    }
    return path.posix.join(options.homeDirectory, "Library", "Application Support", "SiteIndex", "LocalCredentials");
  }

  throw new WordPressCredentialVaultError("UNSUPPORTED_PLATFORM");
}

function normalizedOrigin(siteUrl: string): string {
  try {
    const url = new URL(siteUrl);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      throw new Error("invalid origin");
    }
    return url.origin;
  } catch {
    throw new WordPressCredentialVaultError("INVALID_INPUT");
  }
}

function filePathFor(directory: string, origin: string): string {
  const fingerprint = createHash("sha256").update(origin).digest("hex");
  return path.join(directory, `${VAULT_FILE_PREFIX}${fingerprint}${VAULT_FILE_SUFFIX}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function validateCredential(value: WordPressCredentialInput): { origin: string; credential: WordPressCredential } {
  if (
    typeof value.siteUrl !== "string" ||
    value.siteUrl.length > 2048 ||
    typeof value.username !== "string" ||
    typeof value.applicationPassword !== "string" ||
    value.username.trim().length === 0 ||
    value.username.length > 256 ||
    value.applicationPassword.trim().length === 0 ||
    value.applicationPassword.length > 512
  ) {
    throw new WordPressCredentialVaultError("INVALID_INPUT");
  }
  return {
    origin: normalizedOrigin(value.siteUrl),
    credential: { username: value.username.trim(), applicationPassword: value.applicationPassword },
  };
}

export function createWordPressCredentialVault(options: WordPressCredentialVaultOptions) {
  const pendingWrites = new Map<string, Promise<void>>();

  function directory(): string {
    if (options.directoryOverride) return options.directoryOverride;
    return resolveWordPressCredentialDirectory(options);
  }

  async function ensureEncryption(): Promise<void> {
    try {
      if (await options.safeStorage.isAsyncEncryptionAvailable()) return;
    } catch {
      // Secure storage failures are intentionally not surfaced with OS details.
    }
    throw new WordPressCredentialVaultError("ENCRYPTION_UNAVAILABLE");
  }

  async function readForOrigin(origin: string): Promise<WordPressCredential | null> {
    const vaultFilePath = filePathFor(directory(), origin);
    let envelopeText: string;
    try {
      envelopeText = await readFile(vaultFilePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new WordPressCredentialVaultError("NEEDS_REENTRY");
    }

    try {
      const envelope: unknown = JSON.parse(envelopeText);
      if (
        !isRecord(envelope) ||
        envelope.version !== VAULT_FORMAT_VERSION ||
        typeof envelope.ciphertext !== "string" ||
        !envelope.ciphertext
      ) {
        throw new Error("invalid envelope");
      }
      let decrypted = await options.safeStorage.decryptStringAsync(Buffer.from(envelope.ciphertext, "base64"));
      if (decrypted.shouldReEncrypt)
        decrypted = await options.safeStorage.decryptStringAsync(Buffer.from(envelope.ciphertext, "base64"));
      const payload: unknown = JSON.parse(decrypted.result);
      if (
        !isRecord(payload) ||
        payload.version !== VAULT_FORMAT_VERSION ||
        payload.origin !== origin ||
        typeof payload.username !== "string" ||
        typeof payload.applicationPassword !== "string" ||
        !payload.username ||
        !payload.applicationPassword
      ) {
        throw new Error("invalid payload");
      }
      return { username: payload.username, applicationPassword: payload.applicationPassword };
    } catch {
      throw new WordPressCredentialVaultError("NEEDS_REENTRY");
    }
  }

  async function writeEncrypted(filePath: string, clearText: string): Promise<void> {
    let ciphertext: Buffer;
    try {
      ciphertext = await options.safeStorage.encryptStringAsync(clearText);
    } catch {
      throw new WordPressCredentialVaultError("ENCRYPTION_UNAVAILABLE");
    }
    const envelope = JSON.stringify({ version: VAULT_FORMAT_VERSION, ciphertext: ciphertext.toString("base64") });
    const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, envelope, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, filePath);
    } catch {
      try {
        await unlink(temporaryPath);
      } catch {
        // Cleanup is best effort; the temporary file contains ciphertext only.
      }
      throw new WordPressCredentialVaultError("LOCAL_STORAGE_UNAVAILABLE");
    }
  }

  async function serializeWrite(filePath: string, operation: () => Promise<void>): Promise<void> {
    const previous = pendingWrites.get(filePath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    pendingWrites.set(filePath, current);
    try {
      await current;
    } finally {
      if (pendingWrites.get(filePath) === current) pendingWrites.delete(filePath);
    }
  }

  return {
    async status(siteUrl: string): Promise<WordPressCredentialStatus> {
      let origin: string;
      try {
        origin = normalizedOrigin(siteUrl);
        directory();
        await ensureEncryption();
      } catch {
        return { state: "unavailable" };
      }
      try {
        return (await readForOrigin(origin)) ? { state: "configured" } : { state: "not_configured" };
      } catch {
        return { state: "needs_reentry" };
      }
    },

    async save(input: WordPressCredentialInput): Promise<void> {
      const { origin, credential } = validateCredential(input);
      const vaultFilePath = filePathFor(directory(), origin);
      await ensureEncryption();
      const payload = JSON.stringify({ version: VAULT_FORMAT_VERSION, origin, ...credential });
      await serializeWrite(vaultFilePath, () => writeEncrypted(vaultFilePath, payload));
    },

    /** Main-process-only accessor for a future media Job; never expose through preload. */
    async getForHost(siteUrl: string): Promise<WordPressCredential | null> {
      const origin = normalizedOrigin(siteUrl);
      directory();
      await ensureEncryption();
      return readForOrigin(origin);
    },

    async clear(siteUrl: string): Promise<void> {
      const origin = normalizedOrigin(siteUrl);
      const vaultFilePath = filePathFor(directory(), origin);
      try {
        await unlink(vaultFilePath);
      } catch (error) {
        if (!isMissingFile(error)) throw new WordPressCredentialVaultError("LOCAL_STORAGE_UNAVAILABLE");
      }
    },
  };
}

export type WordPressCredentialVault = ReturnType<typeof createWordPressCredentialVault>;
