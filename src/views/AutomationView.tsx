import React, { useState } from 'react';
import { CheckCheck, ShieldCheck, RefreshCw, Inbox, Boxes, X } from 'lucide-react';
import { apiPost } from '../lib/api';
import { addLog } from '../lib/logs';
import { useData } from '../lib/data';
import { useMask } from '../lib/prefs';
import { setAutomation } from '../lib/accounts';
import { sessionState, type SteamAccount } from '../lib/types';
import { Avatar, PageHeader, SessionBadge, Toggle } from '../components/ui';
import { GAMES } from '../lib/games';

export function AutomationView({ onOpenGuard }: { onOpenGuard: () => void }) {
  const { accounts, sessions, refreshSessions } = useData();
  const mask = useMask();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Collect items
  const [target, setTarget] = useState('');
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [collectApp, setCollectApp] = useState(730);
  const [collectLog, setCollectLog] = useState<string[]>([]);

  const connectedAccounts = accounts.filter((a) => sessions[a.steamId || '']?.loggedIn);

  const runFor = async (label: string, list: SteamAccount[], fn: (a: SteamAccount) => Promise<string>) => {
    const lines: string[] = [];
    for (let i = 0; i < list.length; i++) {
      setBusy(`${label}: ${i + 1}/${list.length}`);
      try {
        lines.push(`${list[i].accountName}: ${await fn(list[i])}`);
      } catch (err: any) {
        lines.push(`${list[i].accountName}: ошибка — ${err.message}`);
      }
    }
    setBusy(null);
    setResult(lines.join('\n'));
  };

  const confirmMarket = (a: SteamAccount) => apiPost('/api/guard/auto', { steamId: a.steamId })
    .then((r) => `подтверждено ${r.accepted} из ${r.total}`);
  const acceptSafe = (a: SteamAccount) => apiPost('/api/steam/offers/accept-safe', { steamId: a.steamId })
    .then((r) => `принято ${r.accepted}, пропущено ${r.skipped} (где нужно что-то отдать)`);

  const collect = async () => {
    const to = accounts.find((a) => a.id === target);
    if (!to) return;
    const from = accounts.filter((a) => sources.has(a.id) && a.id !== target);
    if (!window.confirm(`Собрать все обмениваемые предметы (${GAMES.find((g) => g.id === collectApp)?.name}) с ${from.length} акк. на ${to.accountName}?`)) return;
    const lines: string[] = [];
    setCollectLog([]);
    for (let i = 0; i < from.length; i++) {
      setBusy(`Сбор: ${i + 1}/${from.length}`);
      try {
        const r = await apiPost('/api/steam/transfer', { fromSteamId: from[i].steamId, toSteamId: to.steamId, appId: collectApp, assetIds: [] });
        lines.push(r.items ? `${from[i].accountName}: ${r.items} предм., трейд #${r.offerId}` : `${from[i].accountName}: нечего передавать`);
      } catch (err: any) {
        lines.push(`${from[i].accountName}: ошибка — ${err.message}`);
      }
      setCollectLog([...lines]);
    }
    setBusy(null);
    await addLog({ level: 'info', type: 'collect', message: `Сбор предметов на ${to.accountName}: ${from.length} акк.`, accountName: to.accountName, steamId: to.steamId });
  };

  return (
    <>
      <PageHeader
        title="Автоматизация"
        subtitle="Подтверждение маркета, безопасные трейды и перенос предметов"
        actions={
          <>
            <button disabled={!!busy || !connectedAccounts.length} onClick={() => runFor('Маркет', connectedAccounts, confirmMarket)} className="btn-secondary">
              <CheckCheck size={15} /> Подтвердить маркет у всех
            </button>
            <button disabled={!!busy || !connectedAccounts.length} onClick={() => runFor('Трейды', connectedAccounts, acceptSafe)} className="btn-primary">
              <Inbox size={15} /> Принять безопасные трейды у всех
            </button>
          </>
        }
      />

      <div className="card p-4 mb-6 text-sm text-muted flex gap-3">
        <ShieldCheck size={18} className="text-accent shrink-0 mt-0.5" />
        <div>
          С включённым тумблером приложение раз в 30 секунд <b className="text-ink">подтверждает лоты маркета</b> и трейды, созданные этим приложением,
          и <b className="text-ink">принимает входящие трейды, где вы ничего не отдаёте</b>. Остальные трейды не трогает.
          Работает, пока приложение запущено (в том числе свёрнутым в трей) и аккаунт подключён; после перезапуска сессии восстанавливаются сами.
          Остальные подтверждения ждут вас в разделе «Steam Guard».
        </div>
      </div>

      {busy && <div className="mb-4 chip bg-accent/15 text-accent"><RefreshCw size={12} className="animate-spin" /> {busy}</div>}
      {result && (
        <pre className="card-inset p-3 mb-6 text-xs text-muted whitespace-pre-wrap font-mono relative">
          {result}
          <button onClick={() => setResult(null)} className="absolute top-2 right-2 text-faint hover:text-ink"><X size={14} /></button>
        </pre>
      )}

      <div className="card overflow-x-auto mb-8">
        <table className="w-full text-sm min-w-[820px]">
          <thead className="text-xs text-muted border-b border-line text-left">
            <tr>
              <th className="px-4 py-3">Аккаунт</th>
              <th className="px-4 py-3">Сессия</th>
              <th className="px-4 py-3">Авто</th>
              <th className="px-4 py-3">Последняя ошибка</th>
              <th className="px-4 py-3 text-right">Сейчас</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/60">
            {accounts.map((a) => {
              const s = sessions[a.steamId || ''];
              const live = !!s?.loggedIn;
              return (
                <tr key={a.id}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar src={a.avatar} size={30} />
                      <span className="font-semibold text-ink">{mask(a.personaName || a.accountName, 1)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3"><SessionBadge state={sessionState(a, s)} /></td>
                  <td className="px-4 py-3">
                    <Toggle
                      checked={!!a.automation}
                      disabled={!a.hasToken}
                      label="Автоподтверждение"
                      onChange={async (v) => { await setAutomation(a, v, live); await refreshSessions(); }}
                    />
                  </td>
                  <td className="px-4 py-3 text-xs text-faint max-w-xs truncate" title={s?.lastError || ''}>{s?.lastError || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      <button disabled={!live || !!busy} onClick={() => runFor('Маркет', [a], confirmMarket)} className="btn-ghost btn-sm" title="Подтвердить маркет"><CheckCheck size={14} /></button>
                      <button disabled={!live || !!busy} onClick={() => runFor('Трейды', [a], acceptSafe)} className="btn-ghost btn-sm" title="Принять безопасные трейды"><Inbox size={14} /></button>
                      <button onClick={onOpenGuard} className="btn-secondary btn-sm"><ShieldCheck size={14} /> Подтверждения</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card p-6">
        <h3 className="text-lg font-bold text-ink mb-1 flex items-center gap-2"><Boxes size={18} className="text-accent" /> Сбор вещей на один аккаунт</h3>
        <p className="text-sm text-muted mb-5">
          Все обмениваемые предметы выбранной игры уходят трейдами на главный аккаунт. Отправитель подтверждает их через identity_secret,
          получатель сразу принимает. Оба аккаунта должны быть подключены. Предметы с трейд-баном не передаются.
        </p>
        <div className="grid md:grid-cols-3 gap-4 mb-4">
          <div className="space-y-2">
            <label className="label">Главный аккаунт (получатель)</label>
            <select className="input w-full" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Выберите…</option>
              {connectedAccounts.map((a) => <option key={a.id} value={a.id}>{mask(a.personaName || a.accountName, 1)}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label className="label">Игра</label>
            <select className="input w-full" value={collectApp} onChange={(e) => setCollectApp(Number(e.target.value))}>
              {GAMES.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label className="label">Откуда</label>
            <div className="flex gap-2">
              <button onClick={() => setSources(new Set(connectedAccounts.filter((a) => a.id !== target).map((a) => a.id)))} className="btn-ghost btn-sm">Все подключённые</button>
              <button onClick={() => setSources(new Set())} className="btn-ghost btn-sm">Очистить</button>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mb-5">
          {connectedAccounts.filter((a) => a.id !== target).map((a) => (
            <button
              key={a.id}
              onClick={() => setSources((s) => {
                const n = new Set(s);
                n.has(a.id) ? n.delete(a.id) : n.add(a.id);
                return n;
              })}
              className={`chip px-3 py-1.5 border ${sources.has(a.id) ? 'bg-accent/15 text-accent border-accent/40' : 'bg-raised text-muted border-line'}`}
            >
              {mask(a.personaName || a.accountName, 1)}
            </button>
          ))}
          {connectedAccounts.length === 0 && <span className="text-sm text-faint">Нет подключённых аккаунтов</span>}
        </div>
        <button onClick={collect} disabled={!target || sources.size === 0 || !!busy} className="btn-primary">
          <Boxes size={15} /> Собрать ({[...sources].filter((id) => id !== target).length} акк.)
        </button>
        {collectLog.length > 0 && <pre className="card-inset p-3 mt-4 text-xs text-muted whitespace-pre-wrap font-mono">{collectLog.join('\n')}</pre>}
      </div>

    </>
  );
}
