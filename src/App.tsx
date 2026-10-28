import React, { useEffect, useState } from 'react';
import {
  LayoutDashboard, Users, Package, Zap, Gamepad2, ScrollText, Settings, LogOut, Plus, Play,
  RefreshCw, Mail, Lock, Eye, EyeOff, ShieldAlert, User as UserIcon
} from 'lucide-react';
import { motion } from 'motion/react';
import { onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './lib/firebase';
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

type Tab = 'dashboard' | 'accounts' | 'inventory' | 'automation' | 'games' | 'logs' | 'settings';

const NAV: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'dashboard', label: 'Обзор', icon: <LayoutDashboard size={18} /> },
  { id: 'accounts', label: 'Аккаунты', icon: <Users size={18} /> },
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

function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'register') await createUserWithEmailAndPassword(auth, email, password);
      else await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      const map: Record<string, string> = {
        'auth/email-already-in-use': 'Этот email уже используется.',
        'auth/invalid-email': 'Неверный формат email.',
        'auth/operation-not-allowed': 'Вход по почте не включён в Firebase.',
        'auth/weak-password': 'Пароль слишком слабый (минимум 6 символов).',
        'auth/user-not-found': 'Пользователь не найден.',
        'auth/wrong-password': 'Неверный пароль.',
        'auth/invalid-credential': 'Неверная почта или пароль.'
      };
      setError(map[err.code] || `Ошибка: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-full flex items-center justify-center p-4">
      <Background id="aurora" />
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="relative card p-8 sm:p-10 w-full max-w-md shadow-2xl shadow-black/40">
        <div className="flex flex-col items-center text-center mb-8">
          <Logo size={56} />
          <h1 className="text-3xl font-extrabold text-ink mt-4 tracking-tight">SteamFarmer</h1>
          <p className="text-sm text-muted mt-1">{mode === 'login' ? 'Вход в панель управления аккаунтами' : 'Создание учётной записи'}</p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="label">Почта</label>
            <div className="relative">
              <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="input w-full pl-9" placeholder="name@mail.ru" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="label">Пароль</label>
            <div className="relative">
              <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
              <input
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input w-full pl-9 pr-10"
                placeholder="••••••••"
              />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-ink">
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-bad/10 border border-bad/30 text-bad text-sm flex items-center gap-2">
              <ShieldAlert size={15} className="shrink-0" /> {error}
            </div>
          )}

          <button type="submit" disabled={loading} className="btn-primary w-full py-3 text-base mt-2">
            {loading ? <RefreshCw className="animate-spin" size={18} /> : mode === 'login' ? 'Войти' : 'Зарегистрироваться'}
          </button>
        </form>

        <button
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
          className="w-full mt-6 text-sm text-muted hover:text-accent transition-colors"
        >
          {mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
        </button>
      </motion.div>
    </div>
  );
}

function Shell() {
  const { user, accounts, sessions, refreshSessions } = useData();
  const { prefs, setPrefs } = usePrefs();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [showAdd, setShowAdd] = useState(false);
  const [inventoryAccountId, setInventoryAccountId] = useState<string | null>(null);
  const [startAllStatus, setStartAllStatus] = useState<string | null>(null);

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
            </div>
          ))}
        </nav>
        <div className="m-3 p-3 card-inset flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-accent/15 text-accent flex items-center justify-center"><UserIcon size={14} /></div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-ink truncate">{user.email}</div>
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
            <button onClick={() => signOut(auth)} className="btn-ghost btn-sm hover:text-bad" title="Выйти"><LogOut size={16} /></button>
          </div>
        </header>

        {/* Mobile navigation */}
        <nav className="md:hidden flex gap-1 overflow-x-auto px-3 py-2 border-b border-line bg-surface/70">
          {NAV.map((item) => (
            <button key={item.id} onClick={() => setTab(item.id)} className={`nav-item shrink-0 py-1.5 ${tab === item.id ? 'nav-item-active' : ''}`}>
              {item.icon}<span className="text-xs">{item.label}</span>
            </button>
          ))}
        </nav>

        <main className="flex-1 overflow-y-auto p-4 sm:p-8">
          <div className="max-w-7xl mx-auto">
            {tab === 'dashboard' && <DashboardView onAddAccount={() => setShowAdd(true)} onOpenInventory={openInventory} />}
            {tab === 'accounts' && <AccountsView onOpenInventory={openInventory} />}
            {tab === 'inventory' && <InventoryView initialAccountId={inventoryAccountId} />}
            {tab === 'automation' && <AutomationView />}
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
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => onAuthStateChanged(auth, (u) => {
    setUser(u);
    setLoading(false);
  }), []);

  // Keep the user profile document fresh
  useEffect(() => {
    if (!user) return;
    setDoc(doc(db, 'users', user.uid), {
      uid: user.uid,
      email: user.email,
      lastActive: serverTimestamp(),
      createdAt: serverTimestamp()
    }, { merge: true }).catch((err) => console.warn('Profile sync failed', err));
  }, [user]);

  return (
    <PrefsProvider>
      {loading ? (
        <div className="h-full flex items-center justify-center text-muted">
          <RefreshCw className="animate-spin text-accent mr-3" size={20} /> Загрузка…
        </div>
      ) : user ? (
        <DataProvider user={user}>
          <Shell />
        </DataProvider>
      ) : (
        <AuthScreen />
      )}
    </PrefsProvider>
  );
}
