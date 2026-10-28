import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { apiPost } from './api';
import { listDocs, onStoreChanged } from './store';
import { loginSteamAccount } from './accounts';
import type { SteamAccount, ProxyConfig, SessionInfo, LogEntry } from './types';

interface AppData {
  accounts: SteamAccount[];
  proxies: ProxyConfig[];
  logs: LogEntry[];
  sessions: Record<string, SessionInfo>;
  refreshSessions: () => Promise<void>;
}

const DataContext = createContext<AppData | null>(null);

const SESSION_POLL_MS = 20_000;

function toAccounts(docs: any[]): SteamAccount[] {
  return docs.map((data) => ({
    ...data,
    steamId: data.steamId ? String(data.steamId) : '',
    accountName: data.accountName ? String(data.accountName) : ''
  } as SteamAccount)).sort((a, b) => a.accountName.localeCompare(b.accountName));
}

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [accounts, setAccounts] = useState<SteamAccount[]>([]);
  const [proxies, setProxies] = useState<ProxyConfig[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});
  const [loaded, setLoaded] = useState(false);
  const restoredRef = useRef(false);

  // Local data lives in the main process; it tells us when a collection changes
  useEffect(() => {
    const load = {
      accounts: () => listDocs<any>('accounts').then((d) => setAccounts(toAccounts(d))),
      proxies: () => listDocs<any>('proxies').then((d) => setProxies(d.filter((px) => !px.deleted) as ProxyConfig[])),
      logs: () => listDocs<LogEntry>('logs').then(setLogs)
    };
    Promise.all([load.accounts(), load.proxies(), load.logs()])
      .catch((err) => console.error('Local data', err))
      .finally(() => setLoaded(true));
    return onStoreChanged((collection) => {
      load[collection]().catch((err) => console.error(`Local ${collection}`, err));
    });
  }, []);

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

  // Session restore: on app start, reconnect accounts that run automation
  useEffect(() => {
    if (!loaded || restoredRef.current || accounts.length === 0) return;
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
  }, [loaded, accounts, refreshSessions]);

  return (
    <DataContext.Provider value={{ accounts, proxies, logs, sessions, refreshSessions }}>
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData outside DataProvider');
  return ctx;
}
