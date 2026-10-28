import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  ShieldCheck, RefreshCw, Check, X, AlertTriangle, Copy, KeyRound, Search, ArrowLeftRight, Store, Inbox
} from 'lucide-react';
import { apiPost } from '../lib/api';
import { useData } from '../lib/data';
import { useMask, usePrefs } from '../lib/prefs';
import type { GuardConfirmation, SteamAccount } from '../lib/types';
import { Avatar, EmptyState, PageHeader } from '../components/ui';

type Section = 'confirmations' | 'codes';
type KindFilter = 'all' | 'trade' | 'market' | 'danger';

const KIND_LABELS: Record<GuardConfirmation['kind'], string> = {
  'trade': 'Обмен',
  'market': 'Маркет',
  'api-key': 'Web API ключ',
  'phone': 'Телефон',
  'recovery': 'Восстановление',
  'other': 'Другое'
};

// A confirmation together with the account it belongs to
type FeedItem = GuardConfirmation & { steamId: string; accountName: string };

export function GuardView() {
  const { guard } = useData();
  const [section, setSection] = useState<Section>('confirmations');
  const pending = guard.reduce((sum, a) => sum + a.confirmations.length, 0);

  return (
    <>
      <PageHeader
        title="Steam Guard"
        subtitle="Мобильные подтверждения и коды всех аккаунтов в одном месте"
        actions={
          <div className="flex gap-1 p-1 card-inset">
            <button onClick={() => setSection('confirmations')} className={`btn-sm ${section === 'confirmations' ? 'btn-primary' : 'btn-ghost'}`}>
              <ShieldCheck size={14} /> Подтверждения{pending ? ` (${pending})` : ''}
            </button>
            <button onClick={() => setSection('codes')} className={`btn-sm ${section === 'codes' ? 'btn-primary' : 'btn-ghost'}`}>
              <KeyRound size={14} /> Коды
            </button>
          </div>
        }
      />
      {section === 'confirmations' ? <ConfirmationsFeed /> : <CodesList />}
    </>
  );
}

// ---------------------------------------------------------------- confirmations

function ConfirmationsFeed() {
  const { accounts, sessions, guard, refreshGuard } = useData();
  const mask = useMask();
  const [accountFilter, setAccountFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byId = useMemo(() => new Map(accounts.map((a) => [a.steamId || '', a])), [accounts]);

  const feed: FeedItem[] = useMemo(() => guard
    .flatMap((a) => a.confirmations.map((c) => ({ ...c, steamId: a.steamId, accountName: a.accountName })))
    .sort((a, b) => b.time - a.time), [guard]);

  const visible = feed.filter((c) => {
    if (accountFilter && c.steamId !== accountFilter) return false;
    if (kindFilter === 'danger') return !!c.danger;
    if (kindFilter !== 'all') return c.kind === kindFilter;
    return true;
  });

  // Selection keys are steamId:confirmationId, ids are only unique per account
  const keyOf = (c: FeedItem) => `${c.steamId}:${c.id}`;
  const selectedItems = feed.filter((c) => selected.has(keyOf(c)));

  // Drop selections that disappeared from the feed (confirmed elsewhere or expired)
  useEffect(() => {
    const live = new Set(feed.map(keyOf));
    setSelected((s) => new Set([...s].filter((k) => live.has(k))));
  }, [feed]);

  const toggle = (c: FeedItem) => setSelected((s) => {
    const n = new Set(s);
    n.has(keyOf(c)) ? n.delete(keyOf(c)) : n.add(keyOf(c));
    return n;
  });

  const respond = async (items: FeedItem[], accept: boolean, confirmDanger = false) => {
    setError(null);
    const groups = new Map<string, string[]>();
    for (const c of items) groups.set(c.steamId, [...(groups.get(c.steamId) || []), c.id]);
    const failed: string[] = [];
    let i = 0;
    for (const [steamId, ids] of groups) {
      setBusy(`${accept ? 'Подтверждаю' : 'Отклоняю'} ${++i}/${groups.size}`);
      try {
        await apiPost('/api/guard/respond', { steamId, ids, accept, confirmDanger });
      } catch (err: any) {
        failed.push(`${mask(byId.get(steamId)?.accountName || steamId, 1)}: ${err.message}`);
      }
    }
    setBusy(null);
    setSelected(new Set());
    if (failed.length) setError(failed.join('\n'));
    await refreshGuard();
  };

  const acceptDangerous = (c: FeedItem) => {
    const text = `${c.danger}\n\n${c.title}\nАккаунт: ${c.accountName}\n\nТочно подтвердить?`;
    if (window.confirm(text)) respond([c], true, true);
  };

  const refreshAll = async () => {
    setError(null);
    const live = guard.map((a) => a.steamId);
    for (let i = 0; i < live.length; i++) {
      setBusy(`Обновляю ${i + 1}/${live.length}`);
      await apiPost('/api/guard/refresh', { steamId: live[i] }).catch(() => {});
    }
    setBusy(null);
    await refreshGuard();
  };

  const connected = accounts.filter((a) => sessions[a.steamId || '']?.loggedIn);
  const withoutSecret = connected.filter((a) => !sessions[a.steamId || '']?.canConfirm);
  const offline = accounts.filter((a) => a.steamId && !sessions[a.steamId]?.loggedIn);
  const errors = guard.filter((a) => a.error);
  const pausedUntil = Math.max(0, ...guard.map((a) => a.rateLimitedUntil || 0));
  const pausedCount = guard.filter((a) => a.rateLimitedUntil).length;
  const safeSelectable = visible.filter((c) => !c.danger);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select className="input" value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
          <option value="">Все аккаунты</option>
          {guard.map((a) => (
            <option key={a.steamId} value={a.steamId}>{mask(byId.get(a.steamId)?.personaName || a.accountName, 1)} ({a.confirmations.length})</option>
          ))}
        </select>
        <select className="input" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as KindFilter)}>
          <option value="all">Все типы</option>
          <option value="trade">Обмены</option>
          <option value="market">Маркет</option>
          <option value="danger">Требуют внимания</option>
        </select>
        <button onClick={refreshAll} disabled={!!busy || guard.length === 0} className="btn-ghost">
          <RefreshCw size={14} className={busy?.startsWith('Обновляю') ? 'animate-spin' : ''} /> Обновить
        </button>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            onClick={() => setSelected(new Set(visible.filter((c) => c.kind === 'market' && !c.danger).map(keyOf)))}
            disabled={!visible.some((c) => c.kind === 'market')}
            className="btn-ghost btn-sm"
          >
            <Store size={14} /> Все лоты маркета
          </button>
          <button onClick={() => setSelected(new Set(safeSelectable.map(keyOf)))} disabled={!safeSelectable.length} className="btn-ghost btn-sm">Выбрать все</button>
          <button onClick={() => setSelected(new Set())} disabled={!selected.size} className="btn-ghost btn-sm">Снять</button>
          <button onClick={() => respond(selectedItems, false)} disabled={!selected.size || !!busy} className="btn-danger btn-sm"><X size={14} /> Отклонить</button>
          <button onClick={() => respond(selectedItems, true)} disabled={!selected.size || !!busy} className="btn-primary btn-sm"><Check size={14} /> Подтвердить ({selected.size})</button>
        </div>
      </div>

      {busy && <div className="mb-4 chip bg-accent/15 text-accent"><RefreshCw size={12} className="animate-spin" /> {busy}</div>}
      {error && <pre className="p-3 mb-4 rounded-xl bg-bad/10 border border-bad/30 text-bad text-sm whitespace-pre-wrap font-sans">{error}</pre>}

      {pausedUntil > Date.now() && (
        <div className="card-inset p-3 mb-4 text-sm text-warn flex gap-2 border-warn/40">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            Steam временно ограничил запросы с вашего IP (ошибка 429), затронуто аккаунтов: {pausedCount}.
            Проверка возобновится сама примерно в {new Date(pausedUntil).toLocaleTimeString().slice(0, 5)}.
            <span className="text-muted"> Так бывает, когда много аккаунтов работают с одного IP: помогают прокси на аккаунтах (Настройки → Прокси).</span>
          </div>
        </div>
      )}

      {(offline.length > 0 || withoutSecret.length > 0 || errors.length > 0) && (
        <div className="card-inset p-3 mb-4 text-xs text-muted space-y-1">
          {offline.length > 0 && <div>Не подключены ({offline.length}): их подтверждения появятся после «Подключить все».</div>}
          {withoutSecret.length > 0 && <div>Без identity_secret в maFile ({withoutSecret.length}): {withoutSecret.map((a) => mask(a.accountName, 1)).join(', ')}.</div>}
          {errors.map((a) => <div key={a.steamId} className="text-bad">{mask(a.accountName, 1)}: {a.error}</div>)}
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={<Inbox size={24} />}
          title={feed.length ? 'Ничего не подходит под фильтр' : 'Подтверждений нет'}
          text={guard.length
            ? 'Приложение проверяет подключённые аккаунты раз в 30 секунд и пришлёт уведомление, когда появится новое.'
            : 'Подключите аккаунты с identity_secret, чтобы видеть их подтверждения.'}
        />
      ) : (
        <div className="space-y-2">
          {visible.map((c) => (
            <React.Fragment key={keyOf(c)}>
              <ConfirmationRow
                item={c}
                account={byId.get(c.steamId)}
                partner={c.partnerSteamId ? byId.get(c.partnerSteamId) : undefined}
                selected={selected.has(keyOf(c))}
                busy={!!busy}
                onToggle={() => toggle(c)}
                onAccept={() => (c.danger ? acceptDangerous(c) : respond([c], true))}
                onReject={() => respond([c], false)}
              />
            </React.Fragment>
          ))}
        </div>
      )}
    </>
  );
}

function ConfirmationRow({ item, account, partner, selected, busy, onToggle, onAccept, onReject }: {
  item: FeedItem;
  account?: SteamAccount;
  partner?: SteamAccount;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const mask = useMask();
  const danger = !!item.danger;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className={`card-inset p-3 flex items-start gap-3 ${danger ? 'border-bad/50 bg-bad/5' : selected ? 'border-accent/60' : ''}`}
    >
      <input
        type="checkbox"
        className="accent-[#E8A33D] mt-1.5"
        checked={selected}
        disabled={danger}
        title={danger ? 'Опасные подтверждения принимаются только по одному' : undefined}
        onChange={onToggle}
      />
      {item.icon ? <img src={item.icon} alt="" className="w-10 h-10 rounded-lg" /> : <Avatar src={account?.avatar} size={40} />}
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`chip ${danger ? 'bg-bad/15 text-bad' : item.kind === 'market' ? 'bg-ok/15 text-ok' : 'bg-accent/15 text-accent'}`}>
            {item.kind === 'trade' ? <ArrowLeftRight size={11} /> : item.kind === 'market' ? <Store size={11} /> : <AlertTriangle size={11} />}
            {KIND_LABELS[item.kind]}
          </span>
          <span className="text-xs text-muted">{mask(account?.personaName || item.accountName, 1)}</span>
          <span className="text-[11px] text-faint">{new Date(item.time).toLocaleString()}</span>
          {item.ours && <span className="text-[11px] text-faint">создано приложением</span>}
        </div>
        <div className="font-semibold text-ink mt-1 break-words">{item.title}</div>
        {item.sending && <div className="text-xs text-copper">Отдаёте: {item.sending}</div>}
        {item.receiving && <div className="text-xs text-ok">Получаете: {item.receiving}</div>}
        {item.kind === 'trade' && item.partnerSteamId && (
          <div className="text-xs text-muted mt-0.5">
            Партнёр:{' '}
            {partner
              ? <span className="text-ink">{mask(partner.personaName || partner.accountName, 1)} (ваш аккаунт)</span>
              : <a href={`https://steamcommunity.com/profiles/${item.partnerSteamId}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">{mask(item.partnerSteamId, 4)}</a>}
            {item.give !== undefined && ` · отдаёте ${item.give}, получаете ${item.receive ?? 0}`}
          </div>
        )}
        {danger && <div className="mt-1.5 text-xs text-bad flex gap-1.5"><AlertTriangle size={13} className="shrink-0 mt-px" />{item.danger}</div>}
      </div>
      <div className="flex gap-1.5 shrink-0">
        <button onClick={onReject} disabled={busy} className="btn-ghost btn-sm" title="Отклонить"><X size={15} /></button>
        <button onClick={onAccept} disabled={busy} className={`${danger ? 'btn-danger' : 'btn-secondary'} btn-sm`} title="Подтвердить">
          <Check size={15} /> {danger ? 'Проверить и подтвердить' : ''}
        </button>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------- codes

function CodesList() {
  const { accounts } = useData();
  const { prefs } = usePrefs();
  const mask = useMask();
  const [query, setQuery] = useState('');
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [validFor, setValidFor] = useState(30);
  const [copied, setCopied] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const sealed = useMemo(() => accounts.filter((a) => a.secrets), [accounts]);

  // Codes change every 30 seconds; fetch right after each change
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let tick: ReturnType<typeof setInterval>;
    const load = async () => {
      try {
        const data = await apiPost<{ codes: { id: string; code: string; validFor: number }[] }>(
          '/api/guard/codes', { accounts: sealed.map((a) => ({ id: a.id, sealed: a.secrets })) }
        );
        setCodes(Object.fromEntries(data.codes.map((c) => [c.id, c.code])));
        const left = data.codes[0]?.validFor ?? 30;
        setValidFor(left);
        clearInterval(tick);
        tick = setInterval(() => setValidFor((v) => Math.max(0, v - 1)), 1000);
        timer = setTimeout(load, left * 1000 + 300);
      } catch (err: any) {
        setError(err.message);
        timer = setTimeout(load, 10_000);
      }
    };
    load();
    return () => { clearTimeout(timer); clearInterval(tick); };
  }, [sealed]);

  const copy = (id: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
  };

  const showRevocation = async (a: SteamAccount) => {
    if (revealed[a.id]) {
      setRevealed(({ [a.id]: _, ...rest }) => rest);
      return;
    }
    if (!window.confirm(`Показать код восстановления ${a.accountName}? С ним можно отвязать Steam Guard от аккаунта. Не показывайте его на стриме.`)) return;
    try {
      const data = await apiPost<{ code: string }>('/api/guard/revocation', { sealed: a.secrets, accountName: a.accountName });
      setRevealed((r) => ({ ...r, [a.id]: data.code }));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const visible = sealed.filter((a) => {
    const q = query.trim().toLowerCase();
    return !q || a.accountName.toLowerCase().includes(q) || (a.personaName || '').toLowerCase().includes(q);
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по логину" className="input pl-9 w-64" />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <div className="w-32 h-1.5 bg-raised rounded-full overflow-hidden">
            <div className="h-full bg-accent transition-[width] duration-1000 ease-linear" style={{ width: `${(validFor / 30) * 100}%` }} />
          </div>
          {validFor} с
        </div>
        {prefs.hideSensitive && <span className="text-xs text-faint">Коды скрыты, «Скопировать» работает</span>}
      </div>
      {error && <div className="p-3 mb-4 rounded-xl bg-bad/10 border border-bad/30 text-bad text-sm">{error}</div>}

      {visible.length === 0 ? (
        <EmptyState icon={<KeyRound size={24} />} title="Нет аккаунтов с maFile" text="Импортируйте maFile, чтобы здесь появились коды." />
      ) : (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {visible.map((a) => {
            const code = codes[a.id];
            return (
              <div key={a.id} className="card p-4 flex items-center gap-3">
                <Avatar src={a.avatar} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-ink truncate">{mask(a.personaName || a.accountName, 1)}</div>
                  <div className="text-xs text-faint truncate">{mask(a.accountName)}</div>
                  {revealed[a.id] && <div className="text-xs text-copper font-mono mt-1 select-all">Восстановление: {prefs.hideSensitive ? '•••••' : revealed[a.id]}</div>}
                </div>
                <div className="text-right">
                  <div className="text-2xl font-mono font-bold text-accent tracking-[0.15em]">
                    {code ? (prefs.hideSensitive ? '•••••' : code) : '—'}
                  </div>
                  <div className="flex justify-end gap-1 mt-1">
                    <button onClick={() => showRevocation(a)} className="btn-ghost btn-sm" title="Код восстановления"><KeyRound size={13} /></button>
                    <button onClick={() => code && copy(a.id, code)} disabled={!code} className="btn-ghost btn-sm" title="Скопировать">
                      {copied === a.id ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
