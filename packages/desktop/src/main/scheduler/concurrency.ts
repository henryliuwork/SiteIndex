export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let firstFailure: unknown;
  let hasFailure = false;
  const workerCount = Math.min(items.length, Math.max(1, limit));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        try {
          results[index] = await map(items[index]!, index);
        } catch (error) {
          if (!hasFailure) {
            hasFailure = true;
            firstFailure = error;
          }
        }
      }
    }),
  );
  if (hasFailure) throw firstFailure;
  return results;
}
