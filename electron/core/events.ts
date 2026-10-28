// Things the core did on its own (auto-accepted trades, confirmations, transfers).
// The main process subscribes and writes them into the local history.

export type ServerEvent = {
  id: string;
  time: number;
  level: "info" | "success" | "warning" | "error";
  steamId?: string;
  accountName?: string;
  type: string;
  message: string;
};

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let counter = 0;

export function onEvent(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function logEvent(_uid: string, event: Omit<ServerEvent, "id" | "time">) {
  const full: ServerEvent = { ...event, id: `${Date.now()}-${++counter}`, time: Date.now() };
  console.log(`[Event] ${event.accountName || event.steamId || ""} ${event.type}: ${event.message}`);
  for (const listener of listeners) listener(full);
}
