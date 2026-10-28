import { contextBridge, ipcRenderer } from "electron";

// The only bridge between the window and the main process. The window never
// gets Node or Electron APIs, just these calls.
// Subscribes to a push message from the main process; returns the unsubscribe
function subscribe<T extends unknown[]>(channel: string, listener: (...args: T) => void) {
  const handler = (_event: unknown, ...args: unknown[]) => listener(...(args as T));
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const bridge = {
  api: (name: string, body?: unknown) => ipcRenderer.invoke("api", name, body),
  store: (op: string, body?: unknown) => ipcRenderer.invoke("store", op, body),
  onStoreChanged: (listener: (collection: string) => void) => subscribe("store:changed", listener),
  onGuardChanged: (listener: () => void) => subscribe("guard:changed", listener),
  onTradesChanged: (listener: () => void) => subscribe("trades:changed", listener),
  onNavigate: (listener: (page: string) => void) => subscribe("app:navigate", listener),
  version: () => ipcRenderer.invoke("app:version") as Promise<string>
};

contextBridge.exposeInMainWorld("sfh", bridge);

export type Bridge = typeof bridge;
