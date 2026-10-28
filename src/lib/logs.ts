import { doc, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import type { LogEntry } from './types';

type NewLog = Omit<LogEntry, 'id' | 'ownerUid' | 'time' | 'source'> & { id?: string; time?: number; source?: LogEntry['source'] };

// Action history lives in users/{uid}/logs; failures here must never break the action itself
export async function addLog(entry: NewLog) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const time = entry.time ?? Date.now();
  const id = entry.id ?? `c-${time}-${Math.random().toString(36).slice(2, 8)}`;
  const data: Record<string, unknown> = {
    ownerUid: uid,
    time,
    level: entry.level,
    type: entry.type,
    message: entry.message,
    source: entry.source ?? 'client'
  };
  if (entry.accountName) data.accountName = entry.accountName;
  if (entry.steamId) data.steamId = entry.steamId;
  try {
    await setDoc(doc(db, 'users', uid, 'logs', id), data);
  } catch (err) {
    console.warn('Log write failed', err);
  }
}
