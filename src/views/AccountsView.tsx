import React, { useMemo, useState } from 'react';
import { Search, Package, Play, RefreshCw, Zap, ZapOff, ArrowUpDown } from 'lucide-react';
import { useData } from '../lib/data';
import { useMask } from '../lib/prefs';
import { loginSteamAccount, setAutomation } from '../lib/accounts';
import { sessionState, type SteamAccount } from '../lib/types';
import { Avatar, PageHeader, SessionBadge } from '../components/ui';
import { BanBadges } from '../components/AccountCard';

type SortKey = 'name' | 'wallet' | 'status';

export function AccountsView({ onOpenInventory }: { onOpenInventory: (accountId: string) => void }) {
  const { accounts, sessions, refreshSessions } = useData();
  const mask = useMask();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('name');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = accounts.filter((a) => !q || [a.accountName, a.personaName, a.steamId].some((v) => (v || '').toLowerCase().includes(q)));
    return list.sort((a, b) => {
      if (sort === 'wallet') return (parseFloat(b.walletBalance || '0') || 0) - (parseFloat(a.walletBalance || '0') || 0);
      if (sort === 'status') {
        return sessionState(a, sessions[a.steamId || '']).localeCompare(sessionState(b, sessions[b.steamId || '']));
      }
      return a.accountName.localeCompare(b.accountName);
    });
  }, [accounts, sessions, search, sort]);

  const toggle = (id: string) => setSelected((s) => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const chosen = accounts.filter((a) => selected.has(a.id));

  const runBulk = async (label: string, fn: (acc: SteamAccount) => Promise<unknown>) => {
    const failed: string[] = [];
    for (let i = 0; i < chosen.length; i++) {
      setProgress(`${label}: ${i + 1}/${chosen.length}`);
      try {
        await fn(chosen[i]);
      } catch (err: any) {
        failed.push(`${chosen[i].accountName}: ${err.message}`);
      }
    }
    setProgress(null);
    await refreshSessions();
    if (failed.length) alert(`Ошибки:\n${failed.join('\n')}`);
  };

  return (
    <>
      <PageHeader
        title="Аккаунты"
        subtitle="Таблица для работы с большим количеством аккаунтов"
        actions={
          <>
            <button disabled={!chosen.length || !!progress} onClick={() => runBulk('Подключение', (a) => loginSteamAccount(a))} className="btn-primary">
              {progress ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
              {progress ?? `Подключить (${chosen.length})`}
            </button>
            <button disabled={!chosen.length || !!progress} onClick={() => runBulk('Автоматизация', (a) => setAutomation(a, true, !!sessions[a.steamId || '']?.loggedIn))} className="btn-secondary">
              <Zap size={15} /> Вкл. авто
            </button>
            <button disabled={!chosen.length || !!progress} onClick={() => runBulk('Автоматизация', (a) => setAutomation(a, false, !!sessions[a.steamId || '']?.loggedIn))} className="btn-secondary">
              <ZapOff size={15} /> Выкл. авто
            </button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative w-full max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input w-full pl-9" placeholder="Поиск" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          <ArrowUpDown size={14} />
          <select className="input py-1.5" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="name">По логину</option>
            <option value="wallet">По балансу</option>
            <option value="status">По статусу сессии</option>
          </select>
        </label>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm min-w-[860px]">
          <thead className="text-xs text-muted border-b border-line">
            <tr>
              <th className="px-4 py-3 w-10">
                <input type="checkbox" className="accent-[#E8A33D]" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} />
              </th>
              <th className="px-4 py-3">Профиль</th>
              <th className="px-4 py-3">Логин</th>
              <th className="px-4 py-3">Сессия</th>
              <th className="px-4 py-3">Блокировки</th>
              <th className="px-4 py-3">Баланс</th>
              <th className="px-4 py-3">Авто</th>
              <th className="px-4 py-3 text-right">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/60">
            {rows.map((acc) => (
              <tr key={acc.id} className={`hover:bg-raised/40 transition-colors ${selected.has(acc.id) ? 'bg-accent/5' : ''}`}>
                <td className="px-4 py-3">
                  <input type="checkbox" className="accent-[#E8A33D]" checked={selected.has(acc.id)} onChange={() => toggle(acc.id)} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar src={acc.avatar} size={34} />
                    <div className="min-w-0">
                      <div className="font-semibold text-ink truncate">{mask(acc.personaName || '—', 1)}</div>
                      <div className="text-[11px] text-faint font-mono">{mask(acc.steamId || acc.id, 4)}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted">{mask(acc.accountName)}</td>
                <td className="px-4 py-3"><SessionBadge state={sessionState(acc, sessions[acc.steamId || ''])} /></td>
                <td className="px-4 py-3"><div className="flex flex-wrap gap-1"><BanBadges account={acc} /></div></td>
                <td className="px-4 py-3 font-semibold">{mask(`${acc.walletBalance || '0.00'} ${acc.walletCurrency || ''}`, 0)}</td>
                <td className="px-4 py-3">{acc.automation ? <span className="chip bg-accent/15 text-accent">вкл</span> : <span className="chip bg-raised text-faint">выкл</span>}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => onOpenInventory(acc.id)} className="btn-ghost btn-sm" title="Инвентарь"><Package size={15} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="p-10 text-center text-muted text-sm">Ничего не найдено</div>}
      </div>
    </>
  );
}
