export async function createWindowThenReconcileInBackground<T>(
  createWindow: () => Promise<T>,
  reconcile: () => Promise<unknown>,
  reportError: (error: unknown) => void,
): Promise<T> {
  const window = await createWindow();
  void reconcile().catch(reportError);
  return window;
}
