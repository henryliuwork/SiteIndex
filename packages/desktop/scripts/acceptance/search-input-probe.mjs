import { waitForObserved } from "./session.mjs";

function searchFailure(message) {
  const error = new Error(message);
  error.acceptanceStatus = "assertion_failed";
  return error;
}

// The caller observes the real packaged IPC request before typing, then reports its completion.
// Keep this probe separate from run.mjs until every SearchInput page preserves its toolbar on refresh.
export async function probeSearchInput({ page, label, isQueryComplete, hasWholeTableLoading,
  query = "abc", timeoutMs = 10_000, intervalMs = 50 }) {
  if (!page || !label || typeof isQueryComplete !== "function" || typeof hasWholeTableLoading !== "function") {
    throw new Error("Search acceptance requires a page, accessible label and refresh observers");
  }
  const input = page.getByRole("searchbox", { name: label });
  if (await input.count() !== 1) throw searchFailure(`Search input ${label} is not unique`);
  await input.focus();
  for (let index = 0; index < query.length; index += 1) {
    await input.pressSequentially(query[index], { delay: 100 });
    const value = await input.inputValue();
    const focused = await input.evaluate((element) => document.activeElement === element);
    if (value !== query.slice(0, index + 1) || !focused) {
      throw searchFailure(`Search input ${label} lost its value or focus while typing`);
    }
    if (await hasWholeTableLoading()) {
      throw searchFailure(`Search input ${label} showed a whole-table loading state`);
    }
  }

  let violation;
  try {
    await waitForObserved(async () => {
      const value = await input.inputValue();
      const focused = await input.evaluate((element) => document.activeElement === element);
      if (value !== query || !focused) {
        violation = searchFailure(`Search input ${label} lost its value or focus during refresh`);
        return true;
      }
      if (await hasWholeTableLoading()) {
        violation = searchFailure(`Search input ${label} showed a whole-table loading state`);
        return true;
      }
      return await isQueryComplete();
    }, { timeoutMs, intervalMs, label: `search refresh ${label}` });
  } catch (error) {
    throw searchFailure(error.message);
  }
  if (violation) throw violation;
}
