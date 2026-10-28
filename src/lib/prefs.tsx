import React, { createContext, useContext, useEffect, useState } from 'react';

// Per-browser UI preferences (not account data), kept in localStorage

export type BackgroundId = 'ember' | 'dunes' | 'grain' | 'aurora' | 'embers' | 'sunset';

export interface Prefs {
  background: BackgroundId;
  // Hide logins, SteamIDs and balances (streamer mode)
  hideSensitive: boolean;
  // Seller fee on market.csgo, percent
  csgoFeePercent: number;
}

const DEFAULT_PREFS: Prefs = {
  background: 'ember',
  hideSensitive: false,
  csgoFeePercent: 5
};

const STORAGE_KEY = 'steamfarmer.prefs';

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

const PrefsContext = createContext<{ prefs: Prefs; setPrefs: (patch: Partial<Prefs>) => void }>({
  prefs: DEFAULT_PREFS,
  setPrefs: () => {}
});

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {}
  }, [prefs]);

  const setPrefs = (patch: Partial<Prefs>) => setPrefsState((p) => ({ ...p, ...patch }));
  return <PrefsContext.Provider value={{ prefs, setPrefs }}>{children}</PrefsContext.Provider>;
}

export const usePrefs = () => useContext(PrefsContext);

// Masks a value in streamer mode: "6thomas7" -> "6t•••••7"
export function useMask() {
  const { prefs } = usePrefs();
  return (value: string | undefined | null, keep = 2) => {
    const text = value || '';
    if (!prefs.hideSensitive || text.length === 0) return text;
    if (text.length <= keep * 2) return '•'.repeat(text.length);
    return text.slice(0, keep) + '•'.repeat(Math.min(6, text.length - keep * 2)) + text.slice(-1);
  };
}
