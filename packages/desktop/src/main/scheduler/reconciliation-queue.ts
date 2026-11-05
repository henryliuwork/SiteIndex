export interface ScheduleReconciliationQueue {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  enqueueForProject<T>(projectId: string, operation: () => Promise<T>): Promise<T>;
  waitForProject(projectId: string): Promise<void>;
}

export function createScheduleReconciliationQueue(): ScheduleReconciliationQueue {
  let tail: Promise<void> = Promise.resolve();
  const pendingByProject = new Map<string, Promise<void>>();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function enqueueForProject<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const result = enqueue(operation);
    let pending: Promise<void>;
    pending = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (pendingByProject.get(projectId) === pending) pendingByProject.delete(projectId);
      });
    pendingByProject.set(projectId, pending);
    return result;
  }

  return {
    enqueue,
    enqueueForProject,
    async waitForProject(projectId) {
      await pendingByProject.get(projectId);
    },
  };
}
