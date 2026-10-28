import { addLogDoc } from './store';
import type { LogEntry } from './types';

type NewLog = Omit<LogEntry, 'id' | 'ownerUid' | 'time' | 'source'> & { id?: string; time?: number; source?: LogEntry['source'] };

// Action history; failures here must never break the action itself
export async function addLog(entry: NewLog) {
  const time = entry.time ?? Date.now();
  const id = entry.id ?? `c-${time}-${Math.random().toString(36).slice(2, 8)}`;
  const data: Record<string, unknown> = {
    id,
    ownerUid: 'local',
    time,
    level: entry.level,
    type: entry.type,
    message: entry.message,
    source: entry.source ?? 'client'
  };
  if (entry.accountName) data.accountName = entry.accountName;
  if (entry.steamId) data.steamId = entry.steamId;
  try {
    await addLogDoc(data);
  } catch (err) {
    console.warn('Log write failed', err);
  }
}
