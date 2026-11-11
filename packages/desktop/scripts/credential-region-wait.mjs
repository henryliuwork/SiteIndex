const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_STABLE_SAMPLES = 2;

async function waitForExactlyOne(locator, { timeoutMs, intervalMs, stableSamples, now, sleep }) {
  const deadline = now() + timeoutMs;
  let latestCount = -1;
  let consecutiveMatches = 0;

  do {
    latestCount = await locator.count().catch(() => -1);
    consecutiveMatches = latestCount === 1 ? consecutiveMatches + 1 : 0;
    if (consecutiveMatches >= stableSamples) return 1;
    if (now() >= deadline) break;
    await sleep(intervalMs);
  } while (now() <= deadline);

  return -1;
}

/**
 * Applies a bounded, exact accessible-name count wait to credential regions.
 * Persistent zero or duplicate matches are returned unchanged for the caller's strict assertion.
 */
export function createCredentialRegionWaitPage(
  page,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    stableSamples = DEFAULT_STABLE_SAMPLES,
    now = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const waitOptions = { timeoutMs, intervalMs, stableSamples, now, sleep };
  return new Proxy(page, {
    get(target, property) {
      if (property === "getByRole") {
        return (role, options) => {
          const isCredentialRegion =
            role === "region" && typeof options?.name === "string" && options.name.startsWith("凭据：");
          const locator = target.getByRole(role, isCredentialRegion ? { ...options, exact: true } : options);
          if (!isCredentialRegion) return locator;

          return new Proxy(locator, {
            get(locatorTarget, locatorProperty) {
              if (locatorProperty === "count") return () => waitForExactlyOne(locatorTarget, waitOptions);
              const value = Reflect.get(locatorTarget, locatorProperty, locatorTarget);
              return typeof value === "function" ? value.bind(locatorTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
