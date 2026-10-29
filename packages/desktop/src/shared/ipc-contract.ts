export const IPC_PREFIX = "si:";

export function ipcChannel(method: string): string {
  return `${IPC_PREFIX}${method}`;
}
