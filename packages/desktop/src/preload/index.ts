import { contextBridge, ipcRenderer } from "electron";
import { createApiBridge } from "./api.js";

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
