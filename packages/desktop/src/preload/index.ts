import { contextBridge, ipcRenderer } from "electron";
import { createApiBridge } from "./api.js";

declare const __SITEINDEX_MOCK_UI__: boolean;

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

if (!__SITEINDEX_MOCK_UI__) {
  contextBridge.exposeInMainWorld("siteindex", siteindex);
}
