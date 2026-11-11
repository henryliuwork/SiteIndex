import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWordPressCredentialVault,
  resolveWordPressCredentialDirectory,
  type SafeStorageAdapter,
} from "./wordpress-credential-vault.js";

const roots: string[] = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeSafeStorage(available = true): SafeStorageAdapter {
  const values = new Map<string, string>();
  let nextId = 0;
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (plainText) => {
      if (!available) throw new Error("fictional secure storage unavailable");
      const id = `cipher-${++nextId}`;
      values.set(id, plainText);
      return Buffer.from(id, "utf8");
    },
    decryptStringAsync: async (encrypted) => {
      if (!available) throw new Error("fictional secure storage unavailable");
      const value = values.get(encrypted.toString("utf8"));
      if (!value) throw new Error("fictional decrypt failure");
      return { result: value, shouldReEncrypt: false };
    },
  };
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "siteindex-wp-vault-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WordPress local credential vault", () => {
  it("uses LOCALAPPDATA on Windows and a Library Application Support directory on macOS", () => {
    expect(
      resolveWordPressCredentialDirectory({
        platform: "win32",
        localAppData: "C:\\Users\\fictional\\AppData\\Local",
        homeDirectory: "C:\\Users\\fictional",
      }),
    ).toBe("C:\\Users\\fictional\\AppData\\Local\\SiteIndex\\LocalCredentials");
    expect(
      resolveWordPressCredentialDirectory({
        platform: "darwin",
        homeDirectory: "/Users/fictional",
        localAppData: undefined,
      }),
    ).toBe("/Users/fictional/Library/Application Support/SiteIndex/LocalCredentials");
    expect(() =>
      resolveWordPressCredentialDirectory({
        platform: "win32",
        localAppData: "\\\\server\\profile",
        homeDirectory: "C:\\Users\\fictional",
      }),
    ).toThrow();
    expect(() =>
      resolveWordPressCredentialDirectory({ platform: "win32", homeDirectory: "C:\\Users\\fictional" }),
    ).toThrow();
  });

  it("stores encrypted host-scoped data and exposes only status to callers", async () => {
    const directory = await tempDirectory();
    const projectDirectory = path.join(directory, "fictional-project");
    await mkdir(projectDirectory, { recursive: true });
    const vault = createWordPressCredentialVault({
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "local-app-data", "SiteIndex", "LocalCredentials"),
      safeStorage: fakeSafeStorage(),
    });
    const input = {
      siteUrl: "https://fictional.example/catalog/",
      username: "fictional-user",
      applicationPassword: "fictional-app-password-1234",
    };

    await expect(vault.status(input.siteUrl)).resolves.toEqual({ state: "not_configured" });
    await vault.save(input);
    await expect(vault.status("https://FICTIONAL.example/another-path")).resolves.toEqual({ state: "configured" });
    await expect(vault.status("https://other-fictional.example")).resolves.toEqual({ state: "not_configured" });
    await expect(vault.getForHost(input.siteUrl)).resolves.toEqual({
      username: input.username,
      applicationPassword: input.applicationPassword,
    });

    const files = await readdir(path.join(directory, "local-app-data", "SiteIndex", "LocalCredentials"));
    expect(files).toHaveLength(1);
    const persisted = await readFile(
      path.join(directory, "local-app-data", "SiteIndex", "LocalCredentials", files[0]!),
      "utf8",
    );
    expect(persisted).not.toContain(input.username);
    expect(persisted).not.toContain(input.applicationPassword);
    expect(JSON.stringify(await vault.status(input.siteUrl))).not.toContain(input.applicationPassword);
    expect(await readdir(projectDirectory)).toEqual([]);
  });

  it("fails closed when OS encryption is unavailable and never writes plaintext", async () => {
    const directory = await tempDirectory();
    const vault = createWordPressCredentialVault({
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "local-app-data", "SiteIndex", "LocalCredentials"),
      safeStorage: fakeSafeStorage(false),
    });
    const input = {
      siteUrl: "https://fictional.example",
      username: "fictional-user",
      applicationPassword: "fictional-app-password",
    };

    await expect(vault.status(input.siteUrl)).resolves.toEqual({ state: "unavailable" });
    await expect(vault.save(input)).rejects.toMatchObject({ code: "ENCRYPTION_UNAVAILABLE" });
    await expect(readdir(path.join(directory, "LocalCredentials"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects HTTP hosts and URLs containing embedded credentials", async () => {
    const directory = await tempDirectory();
    const vault = createWordPressCredentialVault({
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "LocalCredentials"),
      safeStorage: fakeSafeStorage(),
    });

    await expect(
      vault.save({
        siteUrl: "http://fictional.example",
        username: "fictional-user",
        applicationPassword: "fictional-secret",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      vault.save({
        siteUrl: "https://fictional-user:fictional-secret@example.test",
        username: "fictional-user",
        applicationPassword: "fictional-secret",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("requires re-entry if the encrypted file cannot be read on this machine", async () => {
    const directory = await tempDirectory();
    const options = {
      platform: "darwin" as const,
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "LocalCredentials"),
      safeStorage: fakeSafeStorage(),
    };
    const vault = createWordPressCredentialVault(options);
    const siteUrl = "https://fictional.example";
    await vault.save({ siteUrl, username: "fictional-user", applicationPassword: "fictional-secret" });

    const credentialDirectory = path.join(directory, "LocalCredentials");
    const [fileName] = await readdir(credentialDirectory);
    await writeFile(
      path.join(credentialDirectory, fileName!),
      JSON.stringify({ version: 1, ciphertext: "invalid" }),
      "utf8",
    );

    await expect(vault.status(siteUrl)).resolves.toEqual({ state: "needs_reentry" });
    await expect(vault.getForHost(siteUrl)).rejects.toMatchObject({ code: "NEEDS_REENTRY" });
  });

  it("removes only the current host record", async () => {
    const directory = await tempDirectory();
    const vault = createWordPressCredentialVault({
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "LocalCredentials"),
      safeStorage: fakeSafeStorage(),
    });
    await vault.save({
      siteUrl: "https://fictional-one.example",
      username: "user-one",
      applicationPassword: "pass-one",
    });
    await vault.save({
      siteUrl: "https://fictional-two.example",
      username: "user-two",
      applicationPassword: "pass-two",
    });

    await vault.clear("https://fictional-one.example");

    await expect(vault.status("https://fictional-one.example")).resolves.toEqual({ state: "not_configured" });
    await expect(vault.status("https://fictional-two.example")).resolves.toEqual({ state: "configured" });
  });

  it("preserves save-then-clear invocation order while encryption availability is gated", async () => {
    const directory = await tempDirectory();
    const encryptionEntered = deferred();
    const releaseEncryption = deferred();
    const safeStorage = fakeSafeStorage();
    safeStorage.isAsyncEncryptionAvailable = async () => {
      encryptionEntered.resolve();
      await releaseEncryption.promise;
      return true;
    };
    const vault = createWordPressCredentialVault({
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "LocalCredentials"),
      safeStorage,
    });
    const input = {
      siteUrl: "https://fictional.example",
      username: "fictional-user",
      applicationPassword: "fictional-app-password",
    };

    const saving = vault.save(input);
    await encryptionEntered.promise;
    const clearing = vault.clear(input.siteUrl);
    releaseEncryption.resolve();
    await Promise.all([saving, clearing]);

    await expect(vault.status(input.siteUrl)).resolves.toEqual({ state: "not_configured" });
  });

  it("preserves clear-then-save invocation order while clear is gated", async () => {
    const directory = await tempDirectory();
    const clearEntered = deferred();
    const releaseClear = deferred();
    const vault = createWordPressCredentialVault({
      platform: "darwin",
      homeDirectory: "/Users/fictional",
      directoryOverride: path.join(directory, "LocalCredentials"),
      safeStorage: fakeSafeStorage(),
      operationGateForTests: async (operation) => {
        if (operation === "clear") {
          clearEntered.resolve();
          await releaseClear.promise;
        }
      },
    });
    const input = {
      siteUrl: "https://fictional.example",
      username: "fictional-user",
      applicationPassword: "fictional-app-password",
    };

    const clearing = vault.clear(input.siteUrl);
    await clearEntered.promise;
    const saving = vault.save(input);
    releaseClear.resolve();
    await Promise.all([clearing, saving]);

    await expect(vault.status(input.siteUrl)).resolves.toEqual({ state: "configured" });
  });
});
