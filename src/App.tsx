import React, { useEffect, useState } from 'react';
import {
  LayoutDashboard, Users, Package, Zap, Gamepad2, ScrollText, Settings, Plus, Play,
  RefreshCw, Eye, EyeOff, User as UserIcon, ShieldCheck
} from 'lucide-react';
import { DataProvider, useData } from './lib/data';
import { PrefsProvider, usePrefs } from './lib/prefs';
import { loginSteamAccount } from './lib/accounts';
import { Background } from './components/Background';
import { AddAccountModal } from './components/AccountModals';
import { DashboardView } from './views/DashboardView';
import { AccountsView } from './views/AccountsView';
import { InventoryView } from './views/InventoryView';
import { AutomationView } from './views/AutomationView';
import { GamesView } from './views/GamesView';
import { LogsView } from './views/LogsView';
import { SettingsView } from './views/SettingsView';
import { GuardView } from './views/GuardView';
import { bridge } from './lib/bridge';

type Tab = 'dashboard' | 'accounts' | 'guard' | 'inventory' | 'automation' | 'games' | 'logs' | 'settings';

const NAV: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'dashboard', label: 'Обзор', icon: <LayoutDashboard size={18} /> },
  { id: 'accounts', label: 'Аккаунты', icon: <Users size={18} /> },
  { id: 'guard', label: 'Steam Guard', icon: <ShieldCheck size={18} /> },
  { id: 'inventory', label: 'Инвентарь', icon: <Package size={18} /> },
  { id: 'automation', label: 'Автоматизация', icon: <Zap size={18} /> },
  { id: 'games', label: 'Игры', icon: <Gamepad2 size={18} /> },
  { id: 'logs', label: 'История и логи', icon: <ScrollText size={18} /> },
  { id: 'settings', label: 'Настройки', icon: <Settings size={18} /> }
];

function Logo({ size = 36 }: { size?: number }) {
  return (
    <div
      className="rounded-xl bg-gradient-to-br from-accent to-copper text-accent-ink font-extrabold flex items-center justify-center shadow-lg shadow-accent/20"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      SF
    </div>
  );
}

function Shell() {
  const { accounts, sessions, refreshSessions, guard } = useData();
  const { prefs, setPrefs } = usePrefs();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [showAdd, setShowAdd] = useState(false);
  const [inventoryAccountId, setInventoryAccountId] = useState<string | null>(null);
  const [startAllStatus, setStartAllStatus] = useState<string | null>(null);

  // Notifications and the tray menu open a page directly
  useEffect(() => bridge().onNavigate((page) => {
    if (NAV.some((item) => item.id === page)) setTab(page as Tab);
  }), []);

  const pending = guard.reduce((sum, a) => sum + a.confirmations.length, 0);

  const openInventory = (accountId: string) => {
    setInventoryAccountId(accountId);
    setTab('inventory');
  };

  // Log in every account one by one (also repairs corrupted SteamIDs and loads profiles)
  const startAll = async () => {
    const failed: string[] = [];
    for (let i = 0; i < accounts.length; i++) {
      setStartAllStatus(`${i + 1}/${accounts.length}`);
      try {
        await loginSteamAccount(accounts[i]);
      } catch (err: any) {
        failed.push(`${accounts[i].accountName}: ${err.message}`);
      }
    }
    setStartAllStatus(null);
    await refreshSessions();
    if (failed.length > 0) alert(`Не удалось подключить:\n${failed.join('\n')}`);
  };

  const activeCount = accounts.filter((a) => sessions[a.steamId || '']?.loggedIn).length;

  return (
    <div className="relative h-full flex overflow-hidden">
      <Background id={prefs.background} />

      <aside className="relative z-10 w-64 shrink-0 hidden md:flex flex-col bg-surface/80 backdrop-blur border-r border-line">
        <div className="px-5 h-16 flex items-center gap-3 border-b border-line">
          <Logo />
          <div>
            <div className="font-extrabold text-ink leading-none">SteamFarmer</div>
            <div className="text-[11px] text-faint mt-1">менеджер аккаунтов</div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV.map((item) => (
            <div key={item.id} onClick={() => setTab(item.id)} className={`nav-item ${tab === item.id ? 'nav-item-active' : ''}`}>
              {item.icon}
              {item.label}
              {item.id === 'accounts' && <span className="ml-auto text-[11px] bg-raised px-2 py-0.5 rounded-full text-muted">{accounts.length}</span>}
              {item.id === 'guard' && pending > 0 && <span className="ml-auto text-[11px] bg-accent text-accent-ink font-bold px-2 py-0.5 rounded-full">{pending}</span>}
            </div>
          ))}
        </nav>
        <div className="m-3 p-3 card-inset flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-accent/15 text-accent flex items-center justify-center"><UserIcon size={14} /></div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-ink truncate">Локальный профиль</div>
            <div className="text-[11px] text-faint">сессий онлайн: {activeCount}</div>
          </div>
        </div>
      </aside>

      <div className="relative z-10 flex-1 flex flex-col min-w-0">
        <header className="h-16 shrink-0 border-b border-line bg-surface/70 backdrop-blur px-4 sm:px-6 flex items-center justify-between gap-3">
          <div className="flex gap-2">
            <button onClick={startAll} disabled={startAllStatus !== null || accounts.length === 0} className="btn-primary">
              {startAllStatus !== null ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
              <span className="hidden sm:inline">{startAllStatus ? `Подключаю ${startAllStatus}` : 'Подключить все'}</span>
            </button>
            <button onClick={() => setShowAdd(true)} className="btn-secondary">
              <Plus size={15} /> <span className="hidden sm:inline">Импорт maFile</span>
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPrefs({ hideSensitive: !prefs.hideSensitive })}
              className={`btn-ghost btn-sm ${prefs.hideSensitive ? 'text-accent' : ''}`}
              title="Скрывать логины и данные"
            >
              {prefs.hideSensitive ? <EyeOff size={16} /> : <Eye size={16} />}
              <span className="hidden lg:inline">{prefs.hideSensitive ? 'Данные скрыты' : 'Скрыть данные'}</span>
            </button>
          </div>
        </header>

        {/* Mobile navigation */}
        <nav className="md:hidden flex gap-1 overflow-x-auto px-3 py-2 border-b border-line bg-surface/70">
          {NAV.map((item) => (
            <button key={item.id} onClick={() => setTab(item.id)} className={`nav-item shrink-0 py-1.5 ${tab === item.id ? 'nav-item-active' : ''}`}>
              {item.icon}<span className="text-xs">{item.label}{item.id === 'guard' && pending > 0 ? ` (${pending})` : ''}</span>
            </button>
          ))}
        </nav>

        <main className="flex-1 overflow-y-auto p-4 sm:p-8">
          <div className="max-w-7xl mx-auto">
            {tab === 'dashboard' && <DashboardView onAddAccount={() => setShowAdd(true)} onOpenInventory={openInventory} />}
            {tab === 'accounts' && <AccountsView onOpenInventory={openInventory} />}
            {tab === 'inventory' && <InventoryView initialAccountId={inventoryAccountId} />}
            {tab === 'guard' && <GuardView />}
            {tab === 'automation' && <AutomationView onOpenGuard={() => setTab('guard')} />}
            {tab === 'games' && <GamesView />}
            {tab === 'logs' && <LogsView />}
            {tab === 'settings' && <SettingsView />}
          </div>
        </main>
      </div>

      {showAdd && <AddAccountModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}

export default function App() {
  return (
    <PrefsProvider>
      <DataProvider>
        <Shell />
      </DataProvider>
    </PrefsProvider>
  );
}
