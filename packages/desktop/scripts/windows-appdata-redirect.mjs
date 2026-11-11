const REGISTRY_KEYS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders",
];

function registryValueResult(result, key, name) {
  if (result.error) throw new Error("Could not inspect the runner's roaming AppData registry value.");
  if (result.status !== 0) {
    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    if (/unable to find.*(?:registry key|value)|specified registry key or value/iu.test(output)) {
      return { key, name, exists: false, type: null, value: null };
    }
    throw new Error("Could not inspect the runner's roaming AppData registry value.");
  }
  const line = (result.stdout ?? "")
    .split(/\r?\n/u)
    .find((entry) => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+`).test(entry));
  if (!line) throw new Error("Could not parse the runner's roaming AppData registry value.");
  const match = new RegExp(`^\\s*${name}\\s+(REG_\\w+)\\s+(.*)$`).exec(line);
  if (!match) throw new Error("Could not parse the runner's roaming AppData registry value.");
  return { key, name, exists: true, type: match[1], value: match[2] };
}

/**
 * Temporarily redirects only the current runner user's roaming AppData shell-folder values.
 * Registry access is injected so partial writes and restoration failures can be tested safely.
 */
export function createWindowsAppDataRedirect({ appDataRoot, runRegistry }) {
  const originals = [];
  let redirected = false;
  let restored = false;

  function query(key, name) {
    return registryValueResult(runRegistry(["query", key, "/v", name]), key, name);
  }

  function write(key, name, type, value) {
    const result = runRegistry(["add", key, "/v", name, "/t", type, "/d", value, "/f"]);
    if (result.error || result.status !== 0) {
      throw new Error("Could not redirect the runner's roaming AppData registry value.");
    }
  }

  function redirect() {
    for (const [index, key] of REGISTRY_KEYS.entries()) {
      const original = query(key, "AppData");
      originals.push(original);
      write(key, "AppData", index === 0 ? "REG_EXPAND_SZ" : "REG_SZ", appDataRoot);
    }
    redirected = true;
    restored = false;
  }

  function restore() {
    let allRestored = true;
    for (const original of [...originals].reverse()) {
      const args = original.exists
        ? ["add", original.key, "/v", original.name, "/t", original.type, "/d", original.value, "/f"]
        : ["delete", original.key, "/v", original.name, "/f"];
      const result = runRegistry(args);
      const missingDelete = !original.exists && /unable to find/iu.test(`${result.stderr ?? ""}${result.stdout ?? ""}`);
      if (result.error || (result.status !== 0 && !missingDelete)) allRestored = false;
    }
    restored = allRestored;
    if (allRestored) redirected = false;
    return allRestored;
  }

  return {
    redirect,
    restore,
    get redirected() {
      return redirected;
    },
    get restored() {
      return restored;
    },
    get hasChanges() {
      return originals.length > 0;
    },
    get canRemoveProfileRoot() {
      return originals.length === 0 || restored;
    },
  };
}
