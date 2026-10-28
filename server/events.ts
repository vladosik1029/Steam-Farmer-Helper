// In-memory journal of things the server did on its own (auto-accepted trades,
// confirmations, transfers). The client pulls it and stores it in the Firestore history.

export type ServerEvent = {
  id: string;
  time: number;
  level: "info" | "success" | "warning" | "error";
  steamId?: string;
  accountName?: string;
  type: string;
  message: string;
};

const MAX_EVENTS_PER_USER = 500;
const eventsByUid = new Map<string, ServerEvent[]>();
let counter = 0;

export function logEvent(uid: string, event: Omit<ServerEvent, "id" | "time">) {
  const list = eventsByUid.get(uid) || [];
  const full: ServerEvent = { ...event, id: `${Date.now()}-${++counter}`, time: Date.now() };
  list.push(full);
  if (list.length > MAX_EVENTS_PER_USER) list.splice(0, list.length - MAX_EVENTS_PER_USER);
  eventsByUid.set(uid, list);
  console.log(`[Event] ${event.accountName || event.steamId || ""} ${event.type}: ${event.message}`);
}

export function getEvents(uid: string, since = 0): ServerEvent[] {
  return (eventsByUid.get(uid) || []).filter((e) => e.time > since);
}
