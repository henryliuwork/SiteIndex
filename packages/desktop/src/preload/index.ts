import { contextBridge, ipcRenderer } from "electron";
import { createApiBridge } from "./api.js";
import { createWindowApi } from "./window-api.js";

const siteindex = createApiBridge({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  listen: (channel, listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      listener(payload);
    };
    ipcRenderer.on(channel, wrappedListener);
    return () => ipcRenderer.removeListener(channel, wrappedListener);
  },
});

contextBridge.exposeInMainWorld("siteindex", siteindex);
contextBridge.exposeInMainWorld(
  "siteindexWindow",
  createWindowApi(
    {
      send: (channel, payload) => ipcRenderer.send(channel, payload),
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    },
    process.env.SITEINDEX_CREDENTIAL_IPC_TRACE === "1"
      ? (method) => console.info(`__SITEINDEX_CREDENTIAL_IPC__ ${method}`)
      : undefined,
  ),
);
