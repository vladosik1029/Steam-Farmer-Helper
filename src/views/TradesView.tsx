import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight, ArrowDownLeft, ArrowUpRight, Search, RefreshCw, Send, X, Check, Copy, Link2, Star, Trash2,
  AlertTriangle, Clock, Inbox, Package
} from 'lucide-react';
import { apiPost } from '../lib/api';
import { bridge } from '../lib/bridge';
import { useData } from '../lib/data';
import { useMask } from '../lib/prefs';
import { deleteDoc, setDoc } from '../lib/store';
import { GAMES } from '../lib/games';
import type { InventoryItem, SteamAccount, TradeOfferView } from '../lib/types';
import { Avatar, EmptyState, PageHeader, formatRub } from '../components/ui';

type Section = 'new' | 'offers';

type Partner = {
  link: string;
  steamId: string;
  personaName: string;
  avatar: string;
  escrowDays: { me: number | null; them: number | null };
  probation: boolean;
};

// An item put into the offer; key = appid:contextid:assetid
type Picked = InventoryItem & { take: number };
const keyOf = (i: { appid: number; contextid: string; assetid: string }) => `${i.appid}:${i.contextid}:${i.assetid}`;
const contextFor = (appId: number) => (appId === 753 ? 6 : 2);
const iconUrl = (icon: string, size = 96) => icon ? `https://community.akamai.steamstatic.com/economy/image/${icon}/${size}fx${size}f` : '';

export function TradesView() {
  const [section, setSection] = useState<Section>('new');
  return (
    <>
      <PageHeader
        title="Обмены"
        subtitle="Обмен с кем угодно по трейд-ссылке и все офферы ваших аккаунтов"
        actions={
          <div className="flex gap-1 p-1 card-inset">
            <button onClick={() => setSection('new')} className={`btn-sm ${section === 'new' ? 'btn-primary' : 'btn-ghost'}`}><ArrowLeftRight size={14} /> Новый обмен</button>
            <button onClick={() => setSection('offers')} className={`btn-sm ${section === 'offers' ? 'btn-primary' : 'btn-ghost'}`}><Inbox size={14} /> Офферы</button>
          </div>
        }
      />
      {section === 'new' ? <NewTrade onSent={() => setSection('offers')} /> : <OffersList />}
    </>
  );
}

// ---------------------------------------------------------------- new trade

function NewTrade({ onSent }: { onSent: () => void }) {
  const { accounts, sessions, partners } = useData();
  const mask = useMask();
  const connected = accounts.filter((a) => a.steamId && sessions[a.steamId]?.loggedIn);

  const [accountId, setAccountId] = useState('');
  const account = connected.find((a) => a.id === accountId) || connected[0];
  const steamId = account?.steamId || '';

  const [link, setLink] = useState('');
  const [partner, setPartner] = useState<Partner | null>(null);
  const [partnerBusy, setPartnerBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [give, setGive] = useState<Map<string, Picked>>(new Map());
  const [receive, setReceive] = useState<Map<string, Picked>>(new Map());
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [prices, setPrices] = useState<Record<string, number | null>>({});

  const ownPartner = partner ? accounts.find((a) => a.steamId === partner.steamId) : undefined;
  const savedPartner = partner ? partners.find((p) => p.steamId === partner.steamId) : undefined;
  // Someone named like a saved partner but with another SteamID: classic impersonation
  const lookalike = partner && !savedPartner
    ? partners.find((p) => p.steamId !== partner.steamId && [p.label, p.personaName].some((n) => n && n.trim().toLowerCase() === partner.personaName.trim().toLowerCase()))
    : undefined;

  // Changing the account drops the offer: items belong to the old one
  useEffect(() => { setGive(new Map()); setPartner(null); }, [steamId]);

  const checkPartner = async (value = link) => {
    if (!steamId) return;
    setPartnerBusy(true);
    setError(null);
    setPartner(null);
    setReceive(new Map());
    try {
      const data = await apiPost<Partner>('/api/trades/partner', { steamId, link: value });
      setPartner(data);
      setLink(data.link);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPartnerBusy(false);
    }
  };

  // Trade link of one of your own accounts (that account must be connected)
  const pickOwn = async (target: SteamAccount) => {
    setError(null);
    try {
      const data = await apiPost<{ link: string }>('/api/trades/my-link', { steamId: target.steamId });
      setLink(data.link);
      await checkPartner(data.link);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const savePartner = async () => {
    if (!partner) return;
    const label = window.prompt('Подпись для партнёра', partner.personaName || partner.steamId);
    if (!label) return;
    await setDoc('partners', `p_${partner.steamId}`, {
      id: `p_${partner.steamId}`, label: label.trim().slice(0, 64), link: partner.link, steamId: partner.steamId,
      personaName: partner.personaName, avatar: partner.avatar, createdAt: Date.now()
    });
  };

  const copyMyLink = async () => {
    try {
      const data = await apiPost<{ link: string }>('/api/trades/my-link', { steamId });
      await navigator.clipboard.writeText(data.link);
      setNotice('Трейд-ссылка скопирована');
      setTimeout(() => setNotice(null), 2500);
    } catch (err: any) {
      setError(err.message);
    }
  };

  // Prices only for items in the offer: few requests, Steam limits them per IP
  const picked = [...give.values(), ...receive.values()];
  const priceKey = picked.filter((i) => i.marketable).map((i) => `${i.appid}:${i.market_hash_name}`).sort().join('|');
  useEffect(() => {
    const list = picked.filter((i) => i.marketable).map((i) => ({ appId: i.appid, name: i.market_hash_name }));
    if (list.length === 0) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const data = await apiPost('/api/prices', { items: list });
        if (cancelled) return;
        const next: Record<string, number | null> = {};
        for (const i of list) {
          const steam = data.steam[i.name];
          next[`${i.appId}:${i.name}`] = steam?.lowest ?? steam?.median ?? data.csgo?.[i.name] ?? null;
        }
        setPrices((p) => ({ ...p, ...next }));
        if (data.pending > 0) timer = window.setTimeout(load, 10_000);
      } catch {
        // Prices are a hint; the trade works without them
      }
    };
    load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceKey]);

  const sum = (items: Picked[]) => {
    let total = 0, known = 0;
    for (const i of items) {
      const p = prices[`${i.appid}:${i.market_hash_name}`];
      if (p != null) { total += p * i.take; known++; }
    }
    return { total, known, count: items.length };
  };
  const giveSum = sum([...give.values()]);
  const receiveSum = sum([...receive.values()]);

  const toggle = (setter: typeof setGive) => (item: InventoryItem) => setter((m: Map<string, Picked>) => {
    const next = new Map<string, Picked>(m);
    const k = keyOf(item);
    if (next.has(k)) next.delete(k);
    else next.set(k, { ...item, take: Number(item.amount) || 1 });
    return next;
  });
  const setTake = (setter: typeof setGive, k: string, take: number) => setter((m: Map<string, Picked>) => {
    const next = new Map<string, Picked>(m);
    const item = next.get(k);
    if (item) next.set(k, { ...item, take: Math.max(1, Math.min(Number(item.amount) || 1, take)) });
    return next;
  });

  const send = async () => {
    if (!partner || !steamId) return;
    const giveList = [...give.values()];
    const receiveList = [...receive.values()];
    const giveaway = giveList.length > 0 && receiveList.length === 0 && !ownPartner;
    const lines = [
      `Аккаунт: ${account?.accountName}`,
      `Партнёр: ${ownPartner ? `${ownPartner.accountName} (ваш аккаунт)` : `${partner.personaName || ''} ${partner.steamId}`}`,
      `Отдаёте: ${giveList.length} предм.${giveSum.known ? ` ≈ ${formatRub(giveSum.total)}` : ''}`,
      `Получаете: ${receiveList.length} предм.${receiveSum.known ? ` ≈ ${formatRub(receiveSum.total)}` : ''}`
    ];
    if (giveaway) lines.unshift('⚠ Вы только отдаёте предметы чужому аккаунту и ничего не получаете.\n');
    if ((partner.escrowDays.me ?? 0) > 0 || (partner.escrowDays.them ?? 0) > 0) lines.push(`\nУдержание (trade hold): ${partner.escrowDays.me ?? 0} дн. у вас, ${partner.escrowDays.them ?? 0} дн. у партнёра`);
    if (!window.confirm(`${lines.join('\n')}\n\nОтправить и подтвердить обмен?`)) return;

    setSending(true);
    setError(null);
    try {
      const result = await apiPost<{ offerId: string; status: string; note: string | null }>('/api/trades/send', {
        steamId,
        link: partner.link,
        give: giveList.map((i) => ({ appid: i.appid, contextid: i.contextid, assetid: i.assetid, amount: i.take })),
        receive: receiveList.map((i) => ({ appid: i.appid, contextid: i.contextid, assetid: i.assetid, amount: i.take })),
        message: message.trim() || undefined,
        confirmGiveaway: giveaway
      });
      setGive(new Map());
      setReceive(new Map());
      setMessage('');
      setNotice(`Обмен #${result.offerId} отправлен${result.note ? `, но ${result.note}` : ' и подтверждён'}.`);
      setTimeout(onSent, result.note ? 4000 : 1500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  if (connected.length === 0) {
    return <EmptyState icon={<ArrowLeftRight size={24} />} title="Нет подключённых аккаунтов" text="Подключите аккаунт с identity_secret, чтобы отправлять обмены." />;
  }

  return (
    <>
      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <div className="card p-4 space-y-3">
          <label className="label">С какого аккаунта</label>
          <div className="flex gap-2">
            <select className="input flex-1" value={account?.id || ''} onChange={(e) => setAccountId(e.target.value)}>
              {connected.map((a) => <option key={a.id} value={a.id}>{mask(a.personaName || a.accountName, 1)}</option>)}
            </select>
            <button onClick={copyMyLink} className="btn-ghost" title="Скопировать трейд-ссылку этого аккаунта"><Copy size={14} /> Моя ссылка</button>
          </div>
          {account && (
            <div className="flex items-center gap-3 text-xs text-muted">
              <Avatar src={account.avatar} size={32} />
              <span>{mask(account.accountName)}</span>
              {account.tradeBanState && account.tradeBanState !== 'None' && <span className="chip bg-bad/15 text-bad">Трейд-бан: {account.tradeBanState}</span>}
              {!sessions[steamId]?.canConfirm && <span className="chip bg-warn/15 text-warn">нет identity_secret</span>}
            </div>
          )}
        </div>

        <div className="card p-4 space-y-3">
          <label className="label">Партнёр по трейд-ссылке</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Link2 size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
              <input
                className="input w-full pl-9"
                placeholder="https://steamcommunity.com/tradeoffer/new/?partner=…&token=…"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') checkPartner(); }}
              />
            </div>
            <button onClick={() => checkPartner()} disabled={!link.trim() || partnerBusy} className="btn-primary">
              {partnerBusy ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />} Проверить
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {partners.map((p) => (
              <span key={p.id} className="chip bg-raised text-muted border border-line pr-1">
                <button onClick={() => { setLink(p.link); checkPartner(p.link); }} className="hover:text-ink"><Star size={11} className="inline text-accent mr-1" />{mask(p.label, 1)}</button>
                <button onClick={() => window.confirm(`Удалить партнёра «${p.label}»?`) && deleteDoc('partners', p.id)} className="text-faint hover:text-bad ml-1" title="Удалить"><X size={11} /></button>
              </span>
            ))}
            {connected.filter((a) => a.id !== account?.id).slice(0, 8).map((a) => (
              <button key={a.id} onClick={() => pickOwn(a)} className="chip bg-raised text-faint border border-line hover:text-ink">{mask(a.personaName || a.accountName, 1)}</button>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="p-3 mb-4 rounded-xl bg-bad/10 border border-bad/30 text-bad text-sm">{error}</div>}
      {notice && <div className="p-3 mb-4 rounded-xl bg-ok/10 border border-ok/30 text-ok text-sm">{notice}</div>}

      {partner && (
        <div className="card p-4 mb-4 flex flex-wrap items-center gap-4">
          <Avatar src={partner.avatar} size={48} />
          <div className="min-w-0">
            <div className="font-bold text-ink">{mask(partner.personaName || '—', 1)}{ownPartner && <span className="text-xs text-ok font-normal"> · ваш аккаунт {mask(ownPartner.accountName, 1)}</span>}{savedPartner && <span className="text-xs text-accent font-normal"> · {mask(savedPartner.label, 1)}</span>}</div>
            <a href={`https://steamcommunity.com/profiles/${partner.steamId}`} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">{mask(partner.steamId, 4)}</a>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className={`chip ${(partner.escrowDays.them ?? 0) > 0 || (partner.escrowDays.me ?? 0) > 0 ? 'bg-warn/15 text-warn' : 'bg-ok/15 text-ok'}`}>
              <Clock size={11} /> Удержание: {partner.escrowDays.me ?? '?'} / {partner.escrowDays.them ?? '?'} дн.
            </span>
            {partner.probation && <span className="chip bg-warn/15 text-warn">у партнёра ограничения на обмен</span>}
            {lookalike && <span className="chip bg-bad/15 text-bad"><AlertTriangle size={11} /> Имя как у «{lookalike.label}», но это другой аккаунт</span>}
          </div>
          {!savedPartner && !ownPartner && <button onClick={savePartner} className="btn-ghost btn-sm ml-auto"><Star size={13} /> Сохранить партнёра</button>}
        </div>
      )}

      {partner && account && (
        <>
          <div className="grid lg:grid-cols-2 gap-4 mb-4">
            <InventoryPanel
              title="Отдаю"
              tone="give"
              load={(appId) => apiPost<{ inventory: InventoryItem[] }>('/api/steam/inventory', { steamId, appId, proxy: account.proxy || undefined })
                .then((d) => d.inventory.filter((i) => i.tradable))}
              cacheKey={`me:${steamId}`}
              picked={give}
              onToggle={toggle(setGive)}
            />
            <InventoryPanel
              title="Получаю"
              tone="receive"
              load={(appId) => apiPost<{ inventory: InventoryItem[] }>('/api/trades/partner-inventory', { steamId, link: partner.link, appId })
                .then((d) => d.inventory)}
              cacheKey={`them:${partner.steamId}`}
              picked={receive}
              onToggle={toggle(setReceive)}
            />
          </div>

          <div className="card p-4 sticky bottom-0 z-10">
            <div className="grid md:grid-cols-2 gap-4 mb-3">
              <PickedList title="Отдаёте" tone="give" items={[...give.values()]} prices={prices} total={giveSum}
                onRemove={(k) => setGive((m) => { const n = new Map(m); n.delete(k); return n; })}
                onTake={(k, t) => setTake(setGive, k, t)} />
              <PickedList title="Получаете" tone="receive" items={[...receive.values()]} prices={prices} total={receiveSum}
                onRemove={(k) => setReceive((m) => { const n = new Map(m); n.delete(k); return n; })}
                onTake={(k, t) => setTake(setReceive, k, t)} />
            </div>
            {give.size > 0 && receive.size === 0 && !ownPartner && (
              <div className="mb-3 text-xs text-bad flex gap-1.5"><AlertTriangle size={13} className="shrink-0 mt-px" /> Вы только отдаёте предметы чужому аккаунту. Так обычно выглядит обман: проверьте, что это действительно нужно.</div>
            )}
            <div className="flex flex-wrap gap-2">
              <input className="input flex-1 min-w-[200px]" placeholder="Сообщение к обмену (необязательно)" maxLength={128} value={message} onChange={(e) => setMessage(e.target.value)} />
              <button onClick={send} disabled={sending || (give.size === 0 && receive.size === 0)} className="btn-primary">
                {sending ? <RefreshCw size={15} className="animate-spin" /> : <Send size={15} />} Отправить и подтвердить
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function InventoryPanel({ title, tone, load, cacheKey, picked, onToggle }: {
  title: string;
  tone: 'give' | 'receive';
  load: (appId: number) => Promise<InventoryItem[]>;
  cacheKey: string;
  picked: Map<string, Picked>;
  onToggle: (item: InventoryItem) => void;
}) {
  const [appId, setAppId] = useState(730);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const list = await load(appId);
      if (mine === seq.current) setItems(list);
    } catch (err: any) {
      if (mine === seq.current) { setItems([]); setError(err.message); }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, cacheKey]);

  useEffect(() => { reload(); }, [reload]);

  const q = search.trim().toLowerCase();
  const visible = items.filter((i) => !q || (i.market_hash_name || i.name || '').toLowerCase().includes(q));
  const countInOffer = [...picked.values()].filter((i) => i.appid === appId).length;

  return (
    <div className="card p-4 flex flex-col min-h-[420px]">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h3 className={`font-bold flex items-center gap-1.5 ${tone === 'give' ? 'text-copper' : 'text-ok'}`}>
          {tone === 'give' ? <ArrowUpRight size={16} /> : <ArrowDownLeft size={16} />}{title}
        </h3>
        <select className="input py-1.5" value={appId} onChange={(e) => setAppId(Number(e.target.value))}>
          {GAMES.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        {countInOffer > 0 && <span className="chip bg-accent/15 text-accent">в обмене: {countInOffer}</span>}
        <button onClick={reload} disabled={loading} className="btn-ghost btn-sm ml-auto" title="Обновить"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
      </div>
      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <input className="input w-full pl-8 py-1.5" placeholder="Поиск" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {error ? (
        <div className="text-sm text-bad">{error}</div>
      ) : loading && items.length === 0 ? (
        <div className="text-sm text-muted py-8 text-center"><RefreshCw size={14} className="animate-spin inline mr-2" />Загрузка…</div>
      ) : visible.length === 0 ? (
        <div className="text-sm text-faint py-8 text-center"><Package size={18} className="inline mr-2" />Нет обмениваемых предметов</div>
      ) : (
        <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-5 xl:grid-cols-6 gap-2 overflow-y-auto max-h-[360px] pr-1">
          {visible.map((item) => {
            const inOffer = picked.has(keyOf(item));
            return (
              <button
                key={keyOf(item)}
                onClick={() => onToggle(item)}
                title={`${item.market_hash_name || item.name}${(item.amount || 1) > 1 ? ` ×${item.amount}` : ''}`}
                className={`relative aspect-square rounded-lg border bg-raised overflow-hidden ${inOffer ? 'border-accent ring-2 ring-accent/40' : 'border-line hover:border-line-strong'}`}
                style={{ borderBottomColor: item.name_color ? `#${item.name_color}` : undefined, borderBottomWidth: 3 }}
              >
                {item.icon_url && <img src={iconUrl(item.icon_url)} alt="" className="w-full h-full object-contain p-1" loading="lazy" />}
                {(item.amount || 1) > 1 && <span className="absolute bottom-0.5 right-1 text-[10px] text-muted">×{item.amount}</span>}
                {inOffer && <span className="absolute top-0.5 right-0.5 bg-accent text-accent-ink rounded-full p-0.5"><Check size={10} /></span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PickedList({ title, tone, items, prices, total, onRemove, onTake }: {
  title: string;
  tone: 'give' | 'receive';
  items: Picked[];
  prices: Record<string, number | null>;
  total: { total: number; known: number; count: number };
  onRemove: (key: string) => void;
  onTake: (key: string, take: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1.5 text-sm">
        <span className={`font-semibold ${tone === 'give' ? 'text-copper' : 'text-ok'}`}>{title}: {items.length}</span>
        {total.known > 0 && <span className="text-xs text-muted">≈ {formatRub(total.total)}{total.known < total.count ? ` (цены у ${total.known} из ${total.count})` : ''}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
        {items.length === 0 && <span className="text-xs text-faint">ничего</span>}
        {items.map((i) => {
          const k = keyOf(i);
          const price = prices[`${i.appid}:${i.market_hash_name}`];
          return (
            <span key={k} className="chip bg-raised border border-line text-muted max-w-[220px]" title={i.market_hash_name || i.name}>
              {i.icon_url && <img src={iconUrl(i.icon_url, 32)} alt="" className="w-4 h-4" />}
              <span className="truncate">{i.market_hash_name || i.name}</span>
              {(i.amount || 1) > 1 && (
                <input type="number" min={1} max={i.amount} value={i.take} onChange={(e) => onTake(k, Number(e.target.value))} className="w-12 bg-transparent border-b border-line text-ink text-[11px]" />
              )}
              {price != null && <span className="text-faint">{formatRub(price * i.take)}</span>}
              <button onClick={() => onRemove(k)} className="text-faint hover:text-bad"><X size={11} /></button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- offers

const STATE_LABELS: Record<string, { text: string; cls: string }> = {
  Active: { text: 'Ждёт ответа', cls: 'bg-accent/15 text-accent' },
  CreatedNeedsConfirmation: { text: 'Ждёт подтверждения', cls: 'bg-warn/15 text-warn' },
  Accepted: { text: 'Принят', cls: 'bg-ok/15 text-ok' },
  InEscrow: { text: 'На удержании', cls: 'bg-warn/15 text-warn' },
  Declined: { text: 'Отклонён', cls: 'bg-raised text-faint' },
  Canceled: { text: 'Отменён', cls: 'bg-raised text-faint' },
  CanceledBySecondFactor: { text: 'Отменён в подтверждениях', cls: 'bg-raised text-faint' },
  Expired: { text: 'Истёк', cls: 'bg-raised text-faint' },
  Countered: { text: 'Контрпредложение', cls: 'bg-raised text-muted' },
  InvalidItems: { text: 'Предметы недоступны', cls: 'bg-bad/15 text-bad' },
  Invalid: { text: 'Недействителен', cls: 'bg-bad/15 text-bad' }
};

type Direction = 'all' | 'incoming' | 'outgoing';

function OffersList() {
  const { accounts } = useData();
  const mask = useMask();
  const [offers, setOffers] = useState<TradeOfferView[]>([]);
  const [errors, setErrors] = useState<{ accountName: string; error: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState('');
  const [direction, setDirection] = useState<Direction>('all');
  const [activeOnly, setActiveOnly] = useState(true);

  const byId = useMemo(() => new Map(accounts.map((a) => [a.steamId || '', a])), [accounts]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiPost<{ offers: TradeOfferView[]; errors: { accountName: string; error: string }[] }>('/api/trades/offers', {});
      setOffers(data.offers);
      setErrors(data.errors);
    } catch (err: any) {
      setErrors([{ accountName: '', error: err.message }]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload when Steam reports a change; several events in a row cause one reload
  useEffect(() => {
    load();
    let timer: number | undefined;
    const off = bridge().onTradesChanged(() => {
      clearTimeout(timer);
      timer = window.setTimeout(load, 1500);
    });
    return () => { off(); clearTimeout(timer); };
  }, [load]);

  const act = async (offer: TradeOfferView, action: 'accept' | 'decline' | 'cancel') => {
    if (action === 'accept') {
      const give = offer.itemsToGive.length;
      const own = byId.get(offer.partnerSteamId);
      const text = give > 0
        ? `Принять обмен #${offer.id}?\n\nОтдаёте ${give} предм.: ${offer.itemsToGive.slice(0, 10).map((i) => i.market_hash_name || i.name).join(', ')}${give > 10 ? '…' : ''}\nПолучаете ${offer.itemsToReceive.length} предм.\nПартнёр: ${own ? `${own.accountName} (ваш аккаунт)` : offer.partnerSteamId}\n\nОбмен будет подтверждён через Steam Guard.`
        : `Принять обмен #${offer.id}? Вы получаете ${offer.itemsToReceive.length} предм. и ничего не отдаёте.`;
      if (!window.confirm(text)) return;
    } else if (!window.confirm(action === 'cancel' ? `Отменить свой обмен #${offer.id}?` : `Отклонить обмен #${offer.id}?`)) {
      return;
    }
    setBusy(offer.id);
    setMessage(null);
    try {
      const result = await apiPost<{ note: string | null }>('/api/trades/action', { steamId: offer.steamId, offerId: offer.id, action });
      if (result.note) setMessage(`Обмен #${offer.id} принят, но ${result.note}.`);
      await load();
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setBusy(null);
    }
  };

  const visible = offers.filter((o) => {
    if (accountFilter && o.steamId !== accountFilter) return false;
    if (direction === 'incoming' && o.isOurOffer) return false;
    if (direction === 'outgoing' && !o.isOurOffer) return false;
    if (activeOnly && !['Active', 'CreatedNeedsConfirmation', 'InEscrow'].includes(o.stateName)) return false;
    return true;
  });
  const accountsWithOffers = [...new Set(offers.map((o) => o.steamId))];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select className="input" value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
          <option value="">Все аккаунты</option>
          {accountsWithOffers.map((id) => <option key={id} value={id}>{mask(byId.get(id)?.personaName || byId.get(id)?.accountName || id, 1)}</option>)}
        </select>
        <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
          <option value="all">Входящие и исходящие</option>
          <option value="incoming">Входящие</option>
          <option value="outgoing">Исходящие</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
          <input type="checkbox" className="accent-[#E8A33D]" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Только активные
        </label>
        <button onClick={load} disabled={loading} className="btn-ghost ml-auto"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Обновить</button>
      </div>

      {message && <div className="p-3 mb-4 rounded-xl bg-accent/10 border border-accent/30 text-accent text-sm">{message}</div>}
      {errors.length > 0 && (
        <div className="card-inset p-3 mb-4 text-xs text-bad space-y-1">
          {errors.map((e, i) => <div key={i}>{e.accountName ? `${mask(e.accountName, 1)}: ` : ''}{e.error}</div>)}
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState icon={<Inbox size={24} />} title={loading ? 'Загрузка…' : 'Офферов нет'} text="Здесь видны обмены подключённых аккаунтов за последние 14 дней. Входящие принимаются только вручную." />
      ) : (
        <div className="space-y-2">
          {visible.map((o) => {
            const state = STATE_LABELS[o.stateName] || { text: o.stateName, cls: 'bg-raised text-muted' };
            const own = byId.get(o.partnerSteamId);
            const mine = byId.get(o.steamId);
            const active = o.stateName === 'Active';
            const risky = !o.isOurOffer && o.itemsToGive.length > 0 && o.itemsToReceive.length === 0 && !own;
            return (
              <div key={`${o.steamId}:${o.id}`} className={`card-inset p-3 ${risky && active ? 'border-bad/50' : ''}`}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {o.isOurOffer ? <ArrowUpRight size={15} className="text-copper" /> : <ArrowDownLeft size={15} className="text-ok" />}
                  <span className="font-semibold text-ink">{mask(mine?.personaName || o.accountName, 1)}</span>
                  <span className="text-faint">{o.isOurOffer ? '→' : '←'}</span>
                  {own
                    ? <span className="text-ink">{mask(own.personaName || own.accountName, 1)} <span className="text-xs text-faint">(ваш)</span></span>
                    : <a href={`https://steamcommunity.com/profiles/${o.partnerSteamId}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">{mask(o.partnerSteamId, 4)}</a>}
                  <span className={`chip ${state.cls}`}>{state.text}</span>
                  {o.fromApp && <span className="text-[11px] text-faint">из приложения</span>}
                  <span className="text-[11px] text-faint">#{o.id} · {o.created ? new Date(o.created).toLocaleString() : ''}</span>
                  <div className="ml-auto flex gap-1.5">
                    {!o.isOurOffer && active && (
                      <>
                        <button onClick={() => act(o, 'decline')} disabled={busy === o.id} className="btn-ghost btn-sm"><X size={14} /> Отклонить</button>
                        <button onClick={() => act(o, 'accept')} disabled={busy === o.id} className={`${risky ? 'btn-danger' : 'btn-primary'} btn-sm`}><Check size={14} /> Принять</button>
                      </>
                    )}
                    {o.isOurOffer && (active || o.stateName === 'CreatedNeedsConfirmation') && (
                      <button onClick={() => act(o, 'cancel')} disabled={busy === o.id} className="btn-ghost btn-sm"><Trash2 size={14} /> Отменить</button>
                    )}
                  </div>
                </div>
                {o.message && <div className="text-xs text-muted mt-1 italic">«{o.message}»</div>}
                <div className="grid md:grid-cols-2 gap-3 mt-2">
                  <ItemStrip label="Отдаёте" tone="give" items={o.itemsToGive} />
                  <ItemStrip label="Получаете" tone="receive" items={o.itemsToReceive} />
                </div>
                {risky && active && <div className="mt-2 text-xs text-bad flex gap-1.5"><AlertTriangle size={13} className="shrink-0 mt-px" />У вас просят предметы и ничего не дают взамен.</div>}
                {o.escrowEnds && <div className="mt-1 text-xs text-warn">Удержание до {new Date(o.escrowEnds).toLocaleString()}</div>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function ItemStrip({ label, tone, items }: { label: string; tone: 'give' | 'receive'; items: TradeOfferView['itemsToGive'] }) {
  const shown = items.slice(0, 10);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className={`text-xs shrink-0 ${tone === 'give' ? 'text-copper' : 'text-ok'}`}>{label}: {items.length}</span>
      <div className="flex gap-1 overflow-hidden">
        {shown.map((i) => (
          <span key={i.assetid} title={i.market_hash_name || i.name}>
            {i.icon_url ? <img src={iconUrl(i.icon_url, 48)} alt="" className="w-8 h-8 rounded bg-raised border border-line object-contain" /> : <span className="block w-8 h-8 rounded bg-raised border border-line" />}
          </span>
        ))}
        {items.length > shown.length && <span className="text-xs text-faint self-center">+{items.length - shown.length}</span>}
      </div>
    </div>
  );
}
