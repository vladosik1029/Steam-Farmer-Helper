import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { collection, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db } from './firebase';
import { apiPost } from './api';
import { addLog } from './logs';
import { loginSteamAccount } from './accounts';
import type { SteamAccount, ProxyConfig, SessionInfo, LogEntry } from './types';

interface AppData {
  user: User;
  accounts: SteamAccount[];
  proxies: ProxyConfig[];
  logs: LogEntry[];
  sessions: Record<string, SessionInfo>;
  refreshSessions: () => Promise<void>;
}

const DataContext = createContext<AppData | null>(null);

const SESSION_POLL_MS = 20_000;
const EVENTS_POLL_MS = 15_000;

export function DataProvider({ user, children }: { user: User; children: React.ReactNode }) {
  const [accounts, setAccounts] = useState<SteamAccount[]>([]);
  const [proxies, setProxies] = useState<ProxyConfig[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});
  const restoredRef = useRef(false);

  useEffect(() => {
    const unsubAccounts = onSnapshot(query(collection(db, 'users', user.uid, 'steamAccounts')), (snapshot) => {
      setAccounts(snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ...data,
          steamId: data.steamId ? String(data.steamId) : '',
          accountName: data.accountName ? String(data.accountName) : ''
        } as SteamAccount;
      }).sort((a, b) => a.accountName.localeCompare(b.accountName)));
    }, (err) => console.error('Accounts listener', err));

    const unsubProxies = onSnapshot(query(collection(db, 'users', user.uid, 'proxies')), (snapshot) => {
      setProxies(snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() } as ProxyConfig))
        .filter((px) => !(px as any).deleted));
    }, (err) => console.error('Proxies listener', err));

    const unsubLogs = onSnapshot(
      query(collection(db, 'users', user.uid, 'logs'), orderBy('time', 'desc'), limit(500)),
      (snapshot) => setLogs(snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as LogEntry))),
      (err) => console.error('Logs listener', err)
    );

    return () => {
      unsubAccounts();
      unsubProxies();
      unsubLogs();
    };
  }, [user.uid]);

  const refreshSessions = useCallback(async () => {
    try {
      const data = await apiPost<{ sessions: SessionInfo[] }>('/api/steam/sessions');
      setSessions(Object.fromEntries(data.sessions.map((s) => [s.steamId, s])));
    } catch (err) {
      console.warn('Sessions poll failed', err);
    }
  }, []);

  useEffect(() => {
    refreshSessions();
    const timer = setInterval(refreshSessions, SESSION_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshSessions]);

  // Server-side events (auto-accepted trades, confirmations) -> Firestore history
  useEffect(() => {
    const cursorKey = `steamfarmer.eventsCursor.${user.uid}`;
    const pull = async () => {
      let since = 0;
      try { since = Number(localStorage.getItem(cursorKey)) || 0; } catch {}
      try {
        const { events } = await apiPost<{ events: any[] }>('/api/events', { since });
        for (const e of events) {
          await addLog({ ...e, id: `s-${e.id}`, source: 'server' });
          since = Math.max(since, e.time);
        }
        try { localStorage.setItem(cursorKey, String(since)); } catch {}
      } catch {}
    };
    pull();
    const timer = setInterval(pull, EVENTS_POLL_MS);
    return () => clearInterval(timer);
  }, [user.uid]);

  // Session restore: after a server restart, reconnect accounts that run automation
  useEffect(() => {
    if (restoredRef.current || accounts.length === 0) return;
    restoredRef.current = true;
    (async () => {
      const { sessions: live } = await apiPost<{ sessions: SessionInfo[] }>('/api/steam/sessions').catch(() => ({ sessions: [] as SessionInfo[] }));
      const liveIds = new Set(live.filter((s) => s.loggedIn).map((s) => s.steamId));
      for (const acc of accounts) {
        if (acc.automation && acc.hasToken && acc.steamId && !liveIds.has(acc.steamId)) {
          await loginSteamAccount(acc).catch(() => {});
        }
      }
      refreshSessions();
    })();
  }, [accounts, refreshSessions]);

  return (
    <DataContext.Provider value={{ user, accounts, proxies, logs, sessions, refreshSessions }}>
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData outside DataProvider');
  return ctx;
}
