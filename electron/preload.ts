import { contextBridge, ipcRenderer } from "electron";

// The only bridge between the window and the main process. The window never
// gets Node or Electron APIs, just these calls.
const bridge = {
  api: (name: string, body?: unknown) => ipcRenderer.invoke("api", name, body),
  store: (op: string, body?: unknown) => ipcRenderer.invoke("store", op, body),
  onStoreChanged: (listener: (collection: string) => void) => {
    const handler = (_event: unknown, collection: string) => listener(collection);
    ipcRenderer.on("store:changed", handler);
    return () => { ipcRenderer.removeListener("store:changed", handler); };
  },
  version: () => ipcRenderer.invoke("app:version") as Promise<string>
};

contextBridge.exposeInMainWorld("sfh", bridge);

export type Bridge = typeof bridge;
