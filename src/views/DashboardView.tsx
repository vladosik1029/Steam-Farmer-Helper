import React, { useMemo, useState } from 'react';
import { Upload, Search, ShieldAlert, Users, Wifi, Wallet, Zap, ChevronDown } from 'lucide-react';
import { useData } from '../lib/data';
import { useMask } from '../lib/prefs';
import { sessionState, type SteamAccount } from '../lib/types';
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

// "1 234,50 ₽"; currencies Intl doesn't know fall back to the code
function formatMoney(value: number, currency: string) {
  try {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  }
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  return m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
};

type WalletGroup = { currency: string; total: number; accounts: SteamAccount[] };

// Wallet totals per currency; opens into a list with every currency and its accounts
function WalletStat({ groups }: { groups: WalletGroup[] }) {
  const mask = useMask();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const main = groups[0];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={groups.length === 0}
        className="card p-4 flex items-center gap-4 w-full text-left hover:border-accent/40 transition-colors"
      >
        <div className="w-11 h-11 rounded-xl bg-accent/12 text-accent flex items-center justify-center shrink-0"><Wallet size={20} /></div>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted">Баланс кошельков</div>
          <div className="text-xl font-extrabold text-ink truncate">{main ? mask(formatMoney(main.total, main.currency), 0) : '—'}</div>
          <div className="text-[11px] text-faint truncate">
            {groups.length > 1 ? `и ещё ${groups.length - 1} ${plural(groups.length - 1, 'валюта', 'валюты', 'валют')}` : main ? `аккаунтов: ${main.accounts.length}` : 'нет данных'}
          </div>
        </div>
        {groups.length > 0 && <ChevronDown size={16} className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>

      {open && (
        <div className="absolute z-30 right-0 w-80 max-w-[calc(100vw-2rem)] mt-2 card p-2 shadow-2xl shadow-black/40 max-h-96 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.currency}>
              <button
                onClick={() => setExpanded((c) => (c === g.currency ? null : g.currency))}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-raised text-left"
              >
                <span className="chip bg-raised text-muted">{g.currency}</span>
                <span className="text-xs text-faint whitespace-nowrap">{g.accounts.length} акк.</span>
                <span className="ml-auto font-bold text-ink whitespace-nowrap">{mask(formatMoney(g.total, g.currency), 0)}</span>
                <ChevronDown size={14} className={`text-faint transition-transform ${expanded === g.currency ? 'rotate-180' : ''}`} />
              </button>
              {expanded === g.currency && (
                <div className="pl-4 pr-3 pb-2 space-y-1">
                  {g.accounts.map((a) => (
                    <div key={a.id} className="flex justify-between text-xs">
                      <span className="text-muted truncate">{mask(a.personaName || a.accountName, 1)}</span>
                      <span className="text-ink">{mask(formatMoney(parseFloat(a.walletBalance || '0') || 0, g.currency), 0)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
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
    const byCurrency = new Map<string, WalletGroup>();
    for (const a of accounts) {
      const currency = a.walletCurrency || '';
      if (!currency) continue;
      const group = byCurrency.get(currency) || { currency, total: 0, accounts: [] };
      group.total += parseFloat(a.walletBalance || '0') || 0;
      group.accounts.push(a);
      byCurrency.set(currency, group);
    }
    // The currency most accounts use first, its accounts richest first
    const wallets = [...byCurrency.values()].sort((x, y) => y.accounts.length - x.accounts.length || y.total - x.total);
    for (const g of wallets) g.accounts.sort((x, y) => (parseFloat(y.walletBalance || '0') || 0) - (parseFloat(x.walletBalance || '0') || 0));
    return { active, banned, automated, wallets };
  }, [accounts, sessions]);

  const filtered = accounts.filter((a) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [a.accountName, a.personaName, a.steamId].some((v) => (v || '').toLowerCase().includes(q));
  });

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
        <WalletStat groups={stats.wallets} />
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
