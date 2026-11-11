import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const desktopPackage = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
const productName = desktopPackage.build.productName;
const REQUIRED_MEDIA_WASM = [
  "@jsquash/avif/codec/dec/avif_dec.wasm",
  "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
  "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm",
  "@jsquash/webp/codec/dec/webp_dec.wasm",
];

function hasExistingSiteIndexInstall() {
  const uninstallRoots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  for (const root of uninstallRoots) {
    const result = spawnSync("reg.exe", ["query", root, "/s"], { encoding: "utf8", windowsHide: true });
    if (result.error) throw new Error("Cannot inspect Windows uninstall entries before running the installer check.");
    if (result.status !== 0) continue;
    const entries = result.stdout.split(/(?=HKEY_)/i);
    const escapedProductName = productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      entries.some((entry) => {
        const match = /^\s*DisplayName\s+REG_\w+\s+(.+)$/im.exec(entry);
        return match !== null && new RegExp(`^${escapedProductName}(?:\\s+\\d+(?:\\.\\d+)*)?$`).test(match[1].trim());
      })
    ) {
      return true;
    }
  }
  return false;
}

async function waitForNoSiteIndexInstallEntry() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!hasExistingSiteIndexInstall()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("The temporary SiteIndex uninstall left an uninstall entry behind.");
}

function localReference(value) {
  const clean = value.trim().replace(/[?#].*$/, "");
  if (!clean || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(clean)) return null;
  return clean.replace(/^[/\\]+/, "");
}

function referencesFromHtml(content) {
  return [...content.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)]
    .map((match) => localReference(match[1]))
    .filter((value) => value !== null);
}

async function listFiles(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath, root)));
    } else if (entry.isFile()) {
      files.push(relative(root, absolutePath));
    } else {
      throw new Error("Installed UI contains an unsupported resource entry.");
    }
  }
  return files.sort();
}

export async function verifyUiResourceTree(resourcesDirectory, expectedUiDirectory) {
  const uiDirectory = resolve(resourcesDirectory, "ui");
  const htmlPath = join(uiDirectory, "index.html");
  let html;
  try {
    html = await readFile(htmlPath, "utf8");
  } catch {
    throw new Error("Installed resources are missing resources/ui/index.html.");
  }

  const references = referencesFromHtml(html);
  if (references.length === 0) throw new Error("Installed UI index has no local script or stylesheet references.");

  for (const reference of references) {
    const assetPath = resolve(uiDirectory, reference);
    const relativePath = relative(uiDirectory, assetPath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error("Installed UI index references an asset outside resources/ui.");
    }
    try {
      const asset = await stat(assetPath);
      if (!asset.isFile() || asset.size === 0) throw new Error("empty");
    } catch {
      throw new Error(`Installed UI is missing a referenced asset: ${reference}.`);
    }
  }

  const assetsDirectory = join(uiDirectory, "assets");
  let assetFiles;
  try {
    assetFiles = await readdir(assetsDirectory);
  } catch {
    throw new Error("Installed UI is missing resources/ui/assets.");
  }
  if (assetFiles.length === 0) throw new Error("Installed resources/ui/assets is empty.");

  const uiFiles = await listFiles(uiDirectory);
  if (expectedUiDirectory) {
    const expectedFiles = await listFiles(expectedUiDirectory);
    if (
      uiFiles.length !== expectedFiles.length ||
      expectedFiles.some((expectedFile, index) => expectedFile !== uiFiles[index])
    ) {
      throw new Error("Installed resources/ui does not contain the complete built UI file set.");
    }
    for (const file of expectedFiles) {
      const [actual, expected] = await Promise.all([
        readFile(join(uiDirectory, file)),
        readFile(join(expectedUiDirectory, file)),
      ]);
      const actualHash = createHash("sha256").update(actual).digest("hex");
      const expectedHash = createHash("sha256").update(expected).digest("hex");
      if (actualHash !== expectedHash) {
        throw new Error("Installed resources/ui contains an incomplete built UI file.");
      }
    }
  }

  return { referencedAssets: references.length, assetFiles: assetFiles.length, uiFiles: uiFiles.length };
}

export async function verifyMediaWasmResources(resourcesDirectory) {
  const unpackedDirectory = join(resourcesDirectory, "app.asar.unpacked", "node_modules");
  for (const modulePath of REQUIRED_MEDIA_WASM) {
    const wasmPath = join(unpackedDirectory, ...modulePath.split("/"));
    let bytes;
    try {
      bytes = await readFile(wasmPath);
    } catch {
      throw new Error("Installed resources are missing a required media WASM module.");
    }
    try {
      await WebAssembly.compile(bytes);
    } catch {
      throw new Error("Installed resources contain an invalid media WASM module.");
    }
  }
  return { mediaWasmModules: REQUIRED_MEDIA_WASM.length };
}

export async function verifyWindowsInstaller(installerPath, attempts = 2) {
  if (process.platform !== "win32") throw new Error("The Windows installer check can run only on Windows.");
  await access(installerPath);
  if (hasExistingSiteIndexInstall()) {
    throw new Error("An existing SiteIndex installation was found; run the installer check on a clean Windows profile.");
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "siteindex-win-installer-check-"));
  const installDirectory = join(temporaryRoot, "Custom Install");
  let lastTree = null;
  let verificationError = null;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = spawnSync(installerPath, ["/S", `/D=${installDirectory}`], {
        encoding: "utf8",
        timeout: 300_000,
        windowsHide: true,
      });
      if (result.error) throw new Error(`Windows installer failed to start: ${result.error.message}`);
      if (result.status !== 0) {
        throw new Error(`Windows installer exited with code ${result.status ?? "unknown"} on install ${attempt}.`);
      }
      lastTree = await verifyUiResourceTree(
        join(installDirectory, "resources"),
        join(repositoryRoot, "packages", "ui", "dist"),
      );
      await verifyMediaWasmResources(join(installDirectory, "resources"));
    }
  } catch (error) {
    verificationError = error;
  } finally {
    try {
      const uninstallerPath = join(installDirectory, `Uninstall ${productName}.exe`);
      let uninstallerExists = true;
      try {
        await access(uninstallerPath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          uninstallerExists = false;
        } else {
          throw error;
        }
      }
      if (uninstallerExists) {
        const uninstaller = spawnSync(uninstallerPath, ["/S", `_?=${installDirectory}`], {
          encoding: "utf8",
          timeout: 300_000,
          windowsHide: true,
        });
        if (uninstaller.error || uninstaller.status !== 0) {
          throw new Error("The temporary SiteIndex installation could not be uninstalled cleanly.");
        }
      } else if (hasExistingSiteIndexInstall()) {
        throw new Error("The incomplete SiteIndex install left an uninstall entry without its uninstaller.");
      }
      await waitForNoSiteIndexInstallEntry();
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (cleanupError) {
      if (verificationError) {
        throw new AggregateError([verificationError, cleanupError], "Installer verification and cleanup both failed.");
      }
      throw cleanupError;
    }
  }
  if (verificationError) throw verificationError;
  return lastTree;
}

async function main() {
  const installerPath = process.argv[2]
    ? resolve(process.argv[2])
    : join(repositoryRoot, "release", `SiteIndex-Setup-${desktopPackage.version}.exe`);
  const result = await verifyWindowsInstaller(installerPath);
  console.info(
    `Windows installer check passed after two installs to a custom directory (${result.referencedAssets} referenced assets; ${result.uiFiles} UI files; ${result.assetFiles} assets).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Windows installer check failed.");
    process.exitCode = 1;
  });
}
