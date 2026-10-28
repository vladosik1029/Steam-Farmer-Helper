import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Package, RefreshCw, Search, CheckSquare, Square, ExternalLink, Send, X, ShieldAlert, Lock } from 'lucide-react';
import { apiPost } from '../lib/api';
import { addLog } from '../lib/logs';
import { useData } from '../lib/data';
import { useMask, usePrefs } from '../lib/prefs';
import type { InventoryItem } from '../lib/types';
import { GAMES } from '../lib/games';
import { EmptyState, PageHeader, formatRub } from '../components/ui';

// Steam takes 5% + 10% game fee; the seller receives roughly price / 1.15
const steamNet = (price: number) => Math.max(0, Math.floor((price / 1.15) * 100) / 100);

type SteamPrice = { lowest: number | null; median: number | null; volume: number } | null;
type PriceData = { steam: Record<string, SteamPrice>; csgo: Record<string, number | null> };
type SortKey = 'price-desc' | 'price-asc' | 'name' | 'csgo-diff';

// Same inventory requested twice at once shares one call (Steam rejects the second as "duplicate")
const inflight = new Map<string, Promise<{ inventory: InventoryItem[] }>>();
function requestInventory(body: { steamId: string; appId: number; proxy?: string }) {
  const key = `${body.steamId}:${body.appId}:${body.proxy || ''}`;
  let promise = inflight.get(key);
  if (!promise) {
    promise = apiPost<{ inventory: InventoryItem[] }>('/api/steam/inventory', body).finally(() => inflight.delete(key));
    inflight.set(key, promise);
  }
  return promise;
}

const iconUrl = (icon: string) => `https://community.akamai.steamstatic.com/economy/image/${icon}/200fx200f`;
const tagOf = (item: InventoryItem, category: string) => item.tags?.find((t) => t.category === category);

export function InventoryView({ initialAccountId }: { initialAccountId?: string | null }) {
  const { accounts, sessions, proxies } = useData();
  const { prefs } = usePrefs();
  const mask = useMask();

  const [accountId, setAccountId] = useState<string>(initialAccountId || accounts[0]?.id || '');
  const [appId, setAppId] = useState(730);
  const [proxyUrl, setProxyUrl] = useState('');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prices, setPrices] = useState<PriceData>({ steam: {}, csgo: {} });
  const [pricePending, setPricePending] = useState(0);
  const [priceRateLimited, setPriceRateLimited] = useState(false);

  // Filters
  const [search, setSearch] = useState('');
  const [tradableOnly, setTradableOnly] = useState(false);
  const [marketableOnly, setMarketableOnly] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [rarityFilter, setRarityFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('price-desc');

  // Selection & transfer
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [transferTarget, setTransferTarget] = useState('');
  const [transferBusy, setTransferBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (initialAccountId) setAccountId(initialAccountId);
  }, [initialAccountId]);

  const account = accounts.find((a) => a.id === accountId);
  const steamId = account?.steamId || '';
  const connected = !!sessions[steamId]?.loggedIn;

  // Only the latest request may update the view (switching account/game quickly, StrictMode double effects)
  const requestSeq = useRef(0);
  const loadInventory = async () => {
    if (!account || !steamId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const data = await requestInventory({
        steamId,
        appId,
        proxy: proxyUrl || account.proxy || undefined
      });
      if (seq !== requestSeq.current) return;
      setItems(Array.isArray(data.inventory) ? data.inventory : []);
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      setItems([]);
      setError(err.message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadInventory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, appId, steamId]);

  // Prices: server answers from cache and queues the rest; poll while something is pending
  const priceTimer = useRef<number | null>(null);
  useEffect(() => {
    const names = [...new Set(items.filter((i) => i.marketable).map((i) => i.market_hash_name))];
    if (names.length === 0) return;
    let cancelled = false;

    const fetchPrices = async () => {
      try {
        const data = await apiPost('/api/prices', { items: names.map((name) => ({ appId, name })) });
        if (cancelled) return;
        setPrices({ steam: data.steam, csgo: data.csgo });
        setPricePending(data.pending);
        setPriceRateLimited(!!data.rateLimitedUntil);
        if (data.pending > 0) priceTimer.current = window.setTimeout(fetchPrices, 8000);
      } catch {
        if (!cancelled) priceTimer.current = window.setTimeout(fetchPrices, 15000);
      }
    };
    fetchPrices();
    return () => {
      cancelled = true;
      if (priceTimer.current) clearTimeout(priceTimer.current);
    };
  }, [items, appId]);

  const steamPriceOf = (item: InventoryItem) => {
    const p = prices.steam[item.market_hash_name];
    return p?.lowest ?? p?.median ?? null;
  };
  const csgoPriceOf = (item: InventoryItem) => (appId === 730 ? prices.csgo[item.market_hash_name] ?? null : null);
  const csgoNet = (price: number) => Math.floor(price * (1 - prefs.csgoFeePercent / 100) * 100) / 100;

  const typeOptions = useMemo(() => [...new Set(items.map((i) => tagOf(i, 'Type')?.localized_tag_name || tagOf(i, 'Type')?.name).filter(Boolean) as string[])].sort(), [items]);
  const rarityOptions = useMemo(() => [...new Set(items.map((i) => tagOf(i, 'Rarity')?.localized_tag_name || tagOf(i, 'Rarity')?.name).filter(Boolean) as string[])].sort(), [items]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = items.filter((i) => {
      if (q && !(i.market_hash_name || i.name || '').toLowerCase().includes(q)) return false;
      if (tradableOnly && !i.tradable) return false;
      if (marketableOnly && !i.marketable) return false;
      const type = tagOf(i, 'Type');
      if (typeFilter && (type?.localized_tag_name || type?.name) !== typeFilter) return false;
      const rarity = tagOf(i, 'Rarity');
      if (rarityFilter && (rarity?.localized_tag_name || rarity?.name) !== rarityFilter) return false;
      return true;
    });
    return list.sort((a, b) => {
      if (sort === 'name') return (a.market_hash_name || '').localeCompare(b.market_hash_name || '');
      if (sort === 'csgo-diff') {
        const diff = (x: InventoryItem) => (csgoPriceOf(x) ?? 0) - (steamPriceOf(x) ?? 0);
        return diff(b) - diff(a);
      }
      const pa = steamPriceOf(a) ?? csgoPriceOf(a) ?? -1;
      const pb = steamPriceOf(b) ?? csgoPriceOf(b) ?? -1;
      return sort === 'price-asc' ? pa - pb : pb - pa;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, search, tradableOnly, marketableOnly, typeFilter, rarityFilter, sort, prices]);

  const toggleItem = (id: string) => setSelected((s) => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const selectedItems = items.filter((i) => selected.has(i.id));
  const totals = useMemo(() => {
    let steam = 0, csgo = 0, steamCount = 0, csgoCount = 0;
    for (const item of selectedItems) {
      const sp = steamPriceOf(item);
      const cp = csgoPriceOf(item);
      const qty = Number(item.amount) || 1;
      if (sp !== null) { steam += sp * qty; steamCount++; }
      if (cp !== null) { csgo += cp * qty; csgoCount++; }
    }
    return { steam, steamNet: steamNet(steam), csgo, csgoNet: csgoNet(csgo), steamCount, csgoCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItems, prices, prefs.csgoFeePercent]);

  const transfer = async () => {
    const target = accounts.find((a) => a.id === transferTarget);
    if (!account || !target?.steamId) return;
    const tradable = selectedItems.filter((i) => i.tradable);
    if (tradable.length === 0) {
      setNotice('Среди выбранных нет обмениваемых предметов.');
      return;
    }
    if (!window.confirm(`Передать ${tradable.length} предм. с ${account.accountName} на ${target.accountName}?`)) return;
    setTransferBusy(true);
    setNotice(null);
    try {
      const result = await apiPost('/api/steam/transfer', {
        fromSteamId: steamId,
        toSteamId: target.steamId,
        appId,
        items: tradable.map((i) => ({ assetid: i.assetid, amount: i.amount || 1 }))
      });
      const notes = result.notes?.length ? ` Трейд ${result.notes.join('; ')}.` : '';
      setNotice(`Отправлено ${result.items} предм. (трейд #${result.offerId}).${notes}`);
      await addLog({ level: 'success', type: 'transfer', message: `Передано ${result.items} предм. → ${target.accountName}`, accountName: account.accountName, steamId });
      setTimeout(loadInventory, 4000);
    } catch (err: any) {
      setNotice(`Ошибка: ${err.message}`);
    } finally {
      setTransferBusy(false);
    }
  };

  if (accounts.length === 0) {
    return <EmptyState icon={<Package size={26} />} title="Нет аккаунтов" text="Сначала импортируйте maFile." />;
  }

  return (
    <div className="pb-28">
      <PageHeader
        title="Инвентарь"
        subtitle={account ? `${mask(account.personaName || account.accountName, 1)} · ${items.length} предметов` : undefined}
        actions={
          <button onClick={loadInventory} disabled={loading} className="btn-secondary">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Обновить
          </button>
        }
      />

      <div className="card p-4 mb-4 flex flex-wrap items-center gap-3">
        <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {sessions[a.steamId || '']?.loggedIn ? '● ' : '○ '}{mask(a.personaName || a.accountName, 1)}
            </option>
          ))}
        </select>
        <div className="flex bg-bg/60 p-1 rounded-xl border border-line">
          {GAMES.map((g) => (
            <button
              key={g.id}
              onClick={() => setAppId(g.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${appId === g.id ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}
            >
              {g.name}
            </button>
          ))}
        </div>
        <select className="input" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} title="Прокси для загрузки">
          <option value="">Прокси аккаунта</option>
          {proxies.map((p) => <option key={p.id} value={p.url}>{p.label}</option>)}
        </select>
        {!connected && (
          <span className="chip bg-warn/15 text-warn"><ShieldAlert size={12} /> Аккаунт не подключён, загрузка может не сработать</span>
        )}
      </div>

      <div className="card p-4 mb-5 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input w-full pl-9" placeholder="Поиск предмета" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {typeOptions.length > 0 && (
          <select className="input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">Все типы</option>
            {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {rarityOptions.length > 0 && (
          <select className="input" value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)}>
            <option value="">Любая редкость</option>
            {rarityOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="price-desc">Сначала дорогие</option>
          <option value="price-asc">Сначала дешёвые</option>
          <option value="name">По названию</option>
          {appId === 730 && <option value="csgo-diff">Выгоднее на market.csgo</option>}
        </select>
        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
          <input type="checkbox" className="accent-[#E8A33D]" checked={tradableOnly} onChange={(e) => setTradableOnly(e.target.checked)} /> Обмениваемые
        </label>
        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
          <input type="checkbox" className="accent-[#E8A33D]" checked={marketableOnly} onChange={(e) => setMarketableOnly(e.target.checked)} /> Продаваемые
        </label>
        <div className="flex gap-2 ml-auto">
          <button onClick={() => setSelected(new Set(visible.map((i) => i.id)))} className="btn-ghost btn-sm"><CheckSquare size={14} /> Выбрать все ({visible.length})</button>
          <button onClick={() => setSelected(new Set())} className="btn-ghost btn-sm"><Square size={14} /> Снять</button>
        </div>
      </div>

      {pricePending > 0 && (
        <p className={`text-xs mb-3 ${priceRateLimited ? 'text-warn' : 'text-faint'}`}>
          {priceRateLimited
            ? `Steam временно ограничил запросы цен (429). Повтор через минуту, осталось ${pricePending}.`
            : `Загружаются цены Steam Market: осталось ${pricePending}. Steam отдаёт около 20 цен в минуту, остальное берётся из кеша.`}
        </p>
      )}

      {loading ? (
        <div className="py-24 flex flex-col items-center gap-3 text-muted">
          <RefreshCw className="animate-spin text-accent" size={32} />
          Загружаю инвентарь…
        </div>
      ) : error ? (
        <EmptyState icon={<ShieldAlert size={26} />} title="Не удалось загрузить" text={error} action={<button onClick={loadInventory} className="btn-primary">Повторить</button>} />
      ) : visible.length === 0 ? (
        <EmptyState icon={<Package size={26} />} title={items.length ? 'Ничего не подходит под фильтры' : 'Инвентарь пуст'} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-7 gap-3">
          {visible.map((item) => {
            const isSel = selected.has(item.id);
            const sp = steamPriceOf(item);
            const cp = csgoPriceOf(item);
            const rarityColor = tagOf(item, 'Rarity')?.color;
            return (
              <div
                key={item.id}
                onClick={() => toggleItem(item.id)}
                className={`group relative card p-3 cursor-pointer transition-all ${isSel ? 'border-accent ring-2 ring-accent/30' : 'hover:border-line-strong'}`}
              >
                <div className="absolute top-2 left-2 z-10">
                  {isSel ? <CheckSquare size={16} className="text-accent" /> : <Square size={16} className="text-faint opacity-0 group-hover:opacity-100" />}
                </div>
                {!item.tradable && (
                  <div className="absolute top-2 right-2 z-10 text-faint" title="Не обменивается"><Lock size={13} /></div>
                )}
                <div className="aspect-square rounded-lg bg-bg/60 flex items-center justify-center mb-2 relative overflow-hidden">
                  <div className="absolute inset-x-0 bottom-0 h-1" style={{ backgroundColor: rarityColor ? `#${rarityColor}` : 'transparent' }} />
                  <img src={iconUrl(item.icon_url)} alt="" loading="lazy" className="w-full h-full object-contain p-1" />
                  {(Number(item.amount) || 1) > 1 && <span className="absolute bottom-2 right-2 chip bg-bg/80 text-ink">×{item.amount}</span>}
                </div>
                <p className="text-xs font-semibold truncate" style={{ color: item.name_color ? `#${item.name_color}` : undefined }} title={item.market_hash_name}>
                  {item.market_hash_name || item.name}
                </p>
                <p className="text-[10px] text-faint truncate mb-2">{item.type}</p>
                <div className="space-y-0.5 text-[11px]">
                  <div className="flex justify-between"><span className="text-faint">Steam</span><span className="font-semibold text-ink">{formatRub(sp)}</span></div>
                  {sp !== null && <div className="flex justify-between"><span className="text-faint">к получению</span><span className="text-ok">{formatRub(steamNet(sp))}</span></div>}
                  {appId === 730 && (
                    <div className="flex justify-between"><span className="text-faint">market.csgo</span><span className="text-copper font-semibold">{formatRub(cp)}</span></div>
                  )}
                </div>
                <div className="absolute inset-x-3 top-[38%] hidden group-hover:flex gap-1 justify-center z-10">
                  <a
                    onClick={(e) => e.stopPropagation()}
                    href={`https://steamcommunity.com/market/listings/${appId}/${encodeURIComponent(item.market_hash_name)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary btn-sm px-2"
                    title="Steam Market"
                  >
                    <ExternalLink size={12} /> Steam
                  </a>
                  {appId === 730 && (
                    <a
                      onClick={(e) => e.stopPropagation()}
                      href={`https://market.csgo.com/ru/?search=${encodeURIComponent(item.market_hash_name)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-secondary btn-sm px-2"
                      title="market.csgo"
                    >
                      <ExternalLink size={12} /> csgo
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[min(1100px,calc(100%-2rem))] card shadow-2xl shadow-black/50 p-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-accent/40">
          <div className="text-sm">
            <div className="font-bold text-ink">Выбрано: {selected.size}</div>
            <button onClick={() => setSelected(new Set())} className="text-xs text-muted hover:text-ink flex items-center gap-1"><X size={12} /> снять выделение</button>
          </div>
          <div className="text-xs">
            <div className="text-faint">Steam Market ({totals.steamCount})</div>
            <div className="font-bold text-ink">{formatRub(totals.steam)} <span className="text-ok font-semibold">→ {formatRub(totals.steamNet)}</span></div>
          </div>
          {appId === 730 && (
            <div className="text-xs">
              <div className="text-faint">market.csgo ({totals.csgoCount}, комиссия {prefs.csgoFeePercent}%)</div>
              <div className="font-bold text-copper">{formatRub(totals.csgo)} <span className="text-ok font-semibold">→ {formatRub(totals.csgoNet)}</span></div>
            </div>
          )}
          {appId === 730 && totals.steamCount > 0 && totals.csgoCount > 0 && (
            <div className="text-xs">
              <div className="text-faint">Выгоднее</div>
              <div className="font-bold text-accent">{totals.csgoNet > totals.steamNet ? 'market.csgo' : 'Steam'} (+{formatRub(Math.abs(totals.csgoNet - totals.steamNet))})</div>
            </div>
          )}
          <div className="flex items-center gap-2 ml-auto">
            <select className="input py-1.5" value={transferTarget} onChange={(e) => setTransferTarget(e.target.value)}>
              <option value="">Передать на аккаунт…</option>
              {accounts.filter((a) => a.id !== accountId && sessions[a.steamId || '']?.loggedIn).map((a) => (
                <option key={a.id} value={a.id}>{mask(a.personaName || a.accountName, 1)}</option>
              ))}
            </select>
            <button onClick={transfer} disabled={!transferTarget || transferBusy || !connected} className="btn-primary" title={!connected ? 'Сначала подключите этот аккаунт' : undefined}>
              {transferBusy ? <RefreshCw size={15} className="animate-spin" /> : <Send size={15} />} Передать
            </button>
          </div>
          {notice && <div className="w-full text-xs text-muted">{notice}</div>}
        </div>
      )}
    </div>
  );
}
