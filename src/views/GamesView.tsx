import React, { useEffect, useState } from 'react';
import { Gamepad2, RefreshCw, Plus, ExternalLink, Check } from 'lucide-react';
import { apiPost } from '../lib/api';
import { addLog } from '../lib/logs';
import { useData } from '../lib/data';
import { useMask } from '../lib/prefs';
import { EmptyState, PageHeader } from '../components/ui';

type FreeGame = { appId: number; title: string; image: string; discount: string | null; url: string };

export function GamesView() {
  const { accounts, sessions } = useData();
  const mask = useMask();
  const [games, setGames] = useState<FreeGame[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickedGames, setPickedGames] = useState<Set<number>>(new Set());
  const [manualIds, setManualIds] = useState('');
  const [pickedAccounts, setPickedAccounts] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<string[]>([]);

  const connected = accounts.filter((a) => sessions[a.steamId || '']?.loggedIn);

  const loadGames = async () => {
    setError(null);
    setGames(null);
    try {
      const data = await apiPost('/api/games/free');
      setGames(data.games);
    } catch (err: any) {
      setError(err.message);
      setGames([]);
    }
  };

  useEffect(() => { loadGames(); }, []);

  const appIds = [
    ...pickedGames,
    ...manualIds.split(/[\s,;]+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0)
  ];

  const addGames = async () => {
    const list = accounts.filter((a) => pickedAccounts.has(a.id));
    const lines: string[] = [];
    setReport([]);
    for (let i = 0; i < list.length; i++) {
      setBusy(`${i + 1}/${list.length}: ${list[i].accountName}`);
      try {
        const r = await apiPost('/api/games/add', { steamId: list[i].steamId, appIds });
        const granted = [...(r.grantedApps || []), ...(r.grantedPackages || [])];
        lines.push(`${list[i].accountName}: ${granted.length ? `добавлено ${granted.join(', ')}` : 'ничего нового (уже есть или раздача не через бесплатную лицензию)'}`);
      } catch (err: any) {
        lines.push(`${list[i].accountName}: ошибка — ${err.message}`);
      }
      setReport([...lines]);
    }
    setBusy(null);
    await addLog({ level: 'info', type: 'free-license', message: `Добавление игр ${appIds.join(', ')} на ${list.length} акк.` });
  };

  const toggle = <T,>(set: Set<T>, value: T) => {
    const n = new Set(set);
    n.has(value) ? n.delete(value) : n.add(value);
    return n;
  };

  return (
    <>
      <PageHeader
        title="Бесплатные игры"
        subtitle="Раздачи Steam и добавление игр сразу на несколько аккаунтов"
        actions={<button onClick={loadGames} className="btn-secondary"><RefreshCw size={15} /> Найти раздачи</button>}
      />

      <div className="grid lg:grid-cols-[1fr_340px] gap-6 items-start">
        <div>
          {error && <div className="p-3 mb-4 rounded-xl bg-bad/10 border border-bad/30 text-bad text-sm">{error}</div>}
          {games === null ? (
            <div className="py-20 text-center text-muted"><RefreshCw className="animate-spin inline mr-2" size={16} />Ищу раздачи в магазине Steam…</div>
          ) : games.length === 0 ? (
            <EmptyState icon={<Gamepad2 size={26} />} title="Сейчас раздач нет" text="Можно вписать AppID вручную справа." />
          ) : (
            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {games.map((g) => {
                const picked = pickedGames.has(g.appId);
                return (
                  <div
                    key={g.appId}
                    onClick={() => setPickedGames((s) => toggle(s, g.appId))}
                    className={`card overflow-hidden cursor-pointer transition-all ${picked ? 'border-accent ring-2 ring-accent/30' : 'hover:border-line-strong'}`}
                  >
                    <div className="relative aspect-[23/9] bg-raised">
                      {g.image && <img src={g.image.replace('capsule_sm_120', 'capsule_231x87')} alt="" className="w-full h-full object-cover" loading="lazy" />}
                      {picked && <div className="absolute top-2 left-2 w-6 h-6 rounded-full bg-accent text-accent-ink flex items-center justify-center"><Check size={14} /></div>}
                      {g.discount && <span className="absolute bottom-2 right-2 chip bg-ok text-bg">{g.discount}</span>}
                    </div>
                    <div className="p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-ink truncate">{g.title}</div>
                        <div className="text-[11px] text-faint">AppID {g.appId}</div>
                      </div>
                      <a href={g.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="btn-ghost btn-sm" title="Открыть в магазине"><ExternalLink size={14} /></a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card p-5 space-y-5 lg:sticky lg:top-0">
          <div className="space-y-2">
            <label className="label">AppID вручную</label>
            <input className="input w-full font-mono" placeholder="например 440, 570" value={manualIds} onChange={(e) => setManualIds(e.target.value)} />
            <p className="text-xs text-faint">Выбрано игр: {appIds.length}</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="label">Аккаунты (только подключённые)</label>
              <button onClick={() => setPickedAccounts(new Set(connected.map((a) => a.id)))} className="text-xs text-accent hover:underline">все</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {connected.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setPickedAccounts((s) => toggle(s, a.id))}
                  className={`chip px-3 py-1.5 border ${pickedAccounts.has(a.id) ? 'bg-accent/15 text-accent border-accent/40' : 'bg-raised text-muted border-line'}`}
                >
                  {mask(a.personaName || a.accountName, 1)}
                </button>
              ))}
              {connected.length === 0 && <span className="text-sm text-faint">Подключите аккаунты на обзоре</span>}
            </div>
          </div>

          <button onClick={addGames} disabled={!appIds.length || !pickedAccounts.size || !!busy} className="btn-primary w-full">
            {busy ? <RefreshCw size={15} className="animate-spin" /> : <Plus size={15} />}
            {busy ?? `Добавить на ${pickedAccounts.size} акк.`}
          </button>

          {report.length > 0 && <pre className="card-inset p-3 text-xs text-muted whitespace-pre-wrap font-mono">{report.join('\n')}</pre>}
        </div>
      </div>
    </>
  );
}
