import React, { useMemo, useState } from 'react';
import { Search, ScrollText, Server, MousePointerClick } from 'lucide-react';
import { useData } from '../lib/data';
import { useMask } from '../lib/prefs';
import type { LogEntry } from '../lib/types';
import { EmptyState, PageHeader } from '../components/ui';

const LEVEL_STYLE: Record<LogEntry['level'], string> = {
  info: 'bg-raised text-muted',
  success: 'bg-ok/15 text-ok',
  warning: 'bg-warn/15 text-warn',
  error: 'bg-bad/15 text-bad'
};

const LEVEL_NAME: Record<LogEntry['level'], string> = {
  info: 'инфо',
  success: 'успех',
  warning: 'внимание',
  error: 'ошибка'
};

export function LogsView() {
  const { logs, accounts } = useData();
  const mask = useMask();
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState<'' | LogEntry['level']>('');
  const [account, setAccount] = useState('');
  const [source, setSource] = useState<'' | LogEntry['source']>('');

  const rows = useMemo(() => logs.filter((l) => {
    if (level && l.level !== level) return false;
    if (account && l.accountName !== account) return false;
    if (source && l.source !== source) return false;
    const q = search.trim().toLowerCase();
    return !q || `${l.message} ${l.type} ${l.accountName || ''}`.toLowerCase().includes(q);
  }), [logs, level, account, source, search]);

  return (
    <>
      <PageHeader title="История и логи" subtitle="Ваши действия и то, что приложение сделало само (последние 500 записей)" />

      <div className="card p-4 mb-5 flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input w-full pl-9" placeholder="Поиск по сообщению" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="input" value={level} onChange={(e) => setLevel(e.target.value as any)}>
          <option value="">Все уровни</option>
          {(Object.keys(LEVEL_NAME) as LogEntry['level'][]).map((l) => <option key={l} value={l}>{LEVEL_NAME[l]}</option>)}
        </select>
        <select className="input" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">Все аккаунты</option>
          {accounts.map((a) => <option key={a.id} value={a.accountName}>{mask(a.accountName)}</option>)}
        </select>
        <select className="input" value={source} onChange={(e) => setSource(e.target.value as any)}>
          <option value="">Все источники</option>
          <option value="client">Мои действия</option>
          <option value="server">Сервер (автоматика)</option>
        </select>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={<ScrollText size={26} />} title="Записей нет" text="Здесь появятся входы, подтверждения, трейды и добавленные игры." />
      ) : (
        <div className="card divide-y divide-line/60">
          {rows.map((l) => (
            <div key={l.id} className="px-4 py-3 flex items-start gap-3 text-sm">
              <span className="text-faint mt-0.5" title={l.source === 'server' ? 'Приложение' : 'Ваше действие'}>
                {l.source === 'server' ? <Server size={14} /> : <MousePointerClick size={14} />}
              </span>
              <span className={`chip shrink-0 ${LEVEL_STYLE[l.level] || LEVEL_STYLE.info}`}>{LEVEL_NAME[l.level] || l.level}</span>
              <div className="min-w-0 flex-1">
                <div className="text-ink break-words">{l.message}</div>
                <div className="text-[11px] text-faint">
                  {new Date(l.time).toLocaleString()} · {l.type}{l.accountName ? ` · ${mask(l.accountName)}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
