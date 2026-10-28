import React, { useMemo, useState } from 'react';
import { Upload, Search, ShieldAlert, Users, Wifi, Wallet, Zap } from 'lucide-react';
import { useData } from '../lib/data';
import { useMask } from '../lib/prefs';
import { sessionState } from '../lib/types';
import { AccountCard } from '../components/AccountCard';
import { EmptyState, PageHeader } from '../components/ui';

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="card p-4 flex items-center gap-4">
      <div className="w-11 h-11 rounded-xl bg-accent/12 text-accent flex items-center justify-center shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="text-xs text-muted">{label}</div>
        <div className="text-xl font-extrabold text-ink truncate">{value}</div>
        {hint && <div className="text-[11px] text-faint truncate">{hint}</div>}
      </div>
    </div>
  );
}

export function DashboardView({ onAddAccount, onOpenInventory }: { onAddAccount: () => void; onOpenInventory: (accountId: string) => void }) {
  const { accounts, sessions } = useData();
  const mask = useMask();
  const [search, setSearch] = useState('');

  const stats = useMemo(() => {
    const active = accounts.filter((a) => sessionState(a, a.steamId ? sessions[a.steamId] : undefined) === 'active').length;
    const banned = accounts.filter((a) => a.vacBanned || (a.gameBans ?? 0) > 0 || a.communityBanned).length;
    const automated = accounts.filter((a) => a.automation).length;
    const wallets: Record<string, number> = {};
    for (const a of accounts) {
      const cur = a.walletCurrency || '';
      if (!cur) continue;
      wallets[cur] = (wallets[cur] || 0) + (parseFloat(a.walletBalance || '0') || 0);
    }
    return { active, banned, automated, wallets };
  }, [accounts, sessions]);

  const filtered = accounts.filter((a) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [a.accountName, a.personaName, a.steamId].some((v) => (v || '').toLowerCase().includes(q));
  });

  const walletText = Object.entries(stats.wallets).map(([cur, sum]) => `${Number(sum).toFixed(2)} ${cur}`).join(' · ') || '—';

  return (
    <>
      <PageHeader title="Обзор" subtitle={`${accounts.length} аккаунтов Steam`} />

      {accounts.some((a) => !a.secrets) && (
        <div className="mb-6 p-4 rounded-2xl border border-copper/30 bg-copper/10 text-copper text-sm flex items-center gap-3">
          <ShieldAlert size={18} className="shrink-0" />
          <span>
            {accounts.filter((a) => !a.secrets).length} акк. хранят пароль и maFile открытым текстом.
            Нажмите <b>«Подключить все»</b>: секреты зашифруются, а пароль заменится токеном.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        <Stat icon={<Users size={20} />} label="Аккаунтов" value={accounts.length} hint={stats.banned ? `с блокировками: ${stats.banned}` : 'без блокировок'} />
        <Stat icon={<Wifi size={20} />} label="Активных сессий" value={`${stats.active} / ${accounts.length}`} />
        <Stat icon={<Zap size={20} />} label="Автоподтверждение" value={stats.automated} hint="аккаунтов с включённым тумблером" />
        <Stat icon={<Wallet size={20} />} label="Баланс кошельков" value={mask(walletText, 0)} />
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          icon={<Upload size={26} />}
          title="Аккаунтов пока нет"
          text="Импортируйте maFile, чтобы добавить аккаунты. Можно выбрать сразу несколько файлов."
          action={<button onClick={onAddAccount} className="btn-primary"><Upload size={16} /> Импорт maFile</button>}
        />
      ) : (
        <>
          <div className="relative mb-4 max-w-sm">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input className="input w-full pl-9" placeholder="Поиск по логину, имени, SteamID" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {filtered.map((acc) => (
              <div key={acc.id}>
                <AccountCard account={acc} onOpenInventory={() => onOpenInventory(acc.id)} />
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
