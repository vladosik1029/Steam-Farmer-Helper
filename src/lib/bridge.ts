import type { Bridge } from '../../electron/preload';

declare global {
  interface Window {
    sfh: Bridge;
  }
}

// Shape of every reply from the main process (errors don't cross IPC with their fields)
export type IpcResult<T> = { ok: boolean; data: T; error?: string; status?: number; code?: string };

export const bridge = (): Bridge => window.sfh;
