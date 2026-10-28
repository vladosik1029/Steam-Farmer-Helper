import TradeOfferManager from "steam-tradeoffer-manager";
import { HttpError } from "./security.ts";
import { logEvent } from "./events.ts";
import { community } from "./community.ts";
import { confirmOffer, getOffer, onTradeEvent, promisify, requireIdentitySecret, type SteamSession } from "./steam.ts";

// ---------------------------------------------------------------------------
// Trades with anyone by trade link: partner details, both inventories, sending
// (with confirmation) and the offer list. Incoming offers are accepted only by
// the user, never automatically.
// ---------------------------------------------------------------------------

const STEAM_ID64_BASE = 76561197960265728n;
const MAX_ITEMS_PER_SIDE = 200;
const MESSAGE_MAX = 128;
const PARTNER_INVENTORY_TTL_MS = 2 * 60_000;
const OFFER_HISTORY_DAYS = 14;

export type TradeLink = { url: string; accountId: string; steamId: string; token: string };

// https://steamcommunity.com/tradeoffer/new/?partner=<accountid>&token=<token>
export function parseTradeLink(value: unknown): TradeLink {
  let url: URL;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new HttpError(400, "Это не ссылка. Вставьте трейд-ссылку из Steam целиком.");
  }
  const partner = url.searchParams.get("partner") || "";
  const token = url.searchParams.get("token") || "";
  if (url.protocol !== "https:" || url.hostname !== "steamcommunity.com" || !/^\/tradeoffer\/new\/?$/.test(url.pathname)) {
    throw new HttpError(400, "Трейд-ссылка должна начинаться с https://steamcommunity.com/tradeoffer/new/");
  }
  if (!/^\d{1,10}$/.test(partner) || Number(partner) <= 0 || Number(partner) > 0xffffffff) {
    throw new HttpError(400, "В ссылке нет правильного partner.");
  }
  if (!/^[\w-]{6,16}$/.test(token)) {
    throw new HttpError(400, "В ссылке нет token. Скопируйте ссылку на странице «Кто может отправлять мне предложения обмена».");
  }
  const steamId = (STEAM_ID64_BASE + BigInt(partner)).toString();
  return { url: `https://steamcommunity.com/tradeoffer/new/?partner=${partner}&token=${token}`, accountId: partner, steamId, token };
}

export function tradeLinkFor(steamId: string, token: string) {
  return `https://steamcommunity.com/tradeoffer/new/?partner=${(BigInt(steamId) - STEAM_ID64_BASE).toString()}&token=${token}`;
}

// The shape the window uses for items everywhere (same as the inventory page)
function toItem(item: any) {
  return {
    id: String(item.assetid || item.id),
    assetid: String(item.assetid || item.id),
    appid: Number(item.appid),
    contextid: String(item.contextid),
    classid: String(item.classid || ""),
    instanceid: String(item.instanceid || "0"),
    amount: Number(item.amount) || 1,
    name: item.name || item.market_name || item.market_hash_name || "",
    market_hash_name: item.market_hash_name || "",
    market_name: item.market_name,
    icon_url: item.icon_url || "",
    name_color: item.name_color,
    type: item.type || "",
    tradable: !!item.tradable,
    marketable: !!item.marketable,
    tags: item.tags
  };
}

const sameAccount = (session: SteamSession, link: TradeLink) => {
  if (link.steamId === session.steamId) throw new HttpError(400, "Это трейд-ссылка этого же аккаунта.");
};

// ---------------------------------------------------------------- partner

export async function tradePartner(session: SteamSession, value: unknown) {
  const link = parseTradeLink(value);
  sameAccount(session, link);
  const draft = session.manager.createOffer(link.url);
  const [me, them] = await community(session.proxy, () => new Promise<any[]>((resolve, reject) =>
    draft.getUserDetails((err: any, mine: any, theirs: any) => (err ? reject(err) : resolve([mine, theirs])))
  )).catch((err: any) => {
    if (err.status === 429) throw err;
    throw new HttpError(400, `Steam не открыл обмен по этой ссылке: ${err.message}. Проверьте, что ссылка актуальная и у партнёра открыт обмен.`);
  });
  return {
    link: link.url,
    steamId: link.steamId,
    personaName: them?.personaName || "",
    avatar: them?.avatarFull || them?.avatarMedium || "",
    // Days the items stay on hold before the trade goes through
    escrowDays: { me: me?.escrowDays ?? null, them: them?.escrowDays ?? null },
    probation: !!them?.probation,
    // Which games the partner has items in: {appid: {name, contexts}}
    apps: Object.fromEntries(Object.entries(them?.contexts || {}).map(([appid, app]: [string, any]) => [
      appid,
      { name: app.name, icon: app.icon, contexts: Object.values(app.rgContexts || {}).map((c: any) => ({ id: String(c.id), name: c.name, count: c.asset_count })) }
    ]))
  };
}

const partnerInventoryCache = new Map<string, { at: number; items: any[] }>();

export async function partnerInventory(session: SteamSession, value: unknown, appId: number, contextId: number) {
  const link = parseTradeLink(value);
  sameAccount(session, link);
  const key = `${link.steamId}:${appId}:${contextId}`;
  const cached = partnerInventoryCache.get(key);
  if (cached && Date.now() - cached.at < PARTNER_INVENTORY_TTL_MS) return cached.items;

  const draft = session.manager.createOffer(link.url);
  let raw: any[];
  try {
    raw = await community(session.proxy, () => promisify<any[]>((cb) => draft.getPartnerInventoryContents(appId, contextId, cb)));
  } catch (err: any) {
    if (err.status === 429) throw err;
    // Private inventory: the trade window endpoint still shows tradable items by token
    raw = await community(session.proxy, () => promisify<any[]>((cb) => draft.loadPartnerInventory(appId, contextId, cb)))
      .catch((e: any) => {
        if (e.status === 429) throw e;
        throw new HttpError(502, `Инвентарь партнёра недоступен: ${e.message}`);
      });
  }
  const items = raw.map(toItem).filter((i) => i.tradable);
  if (partnerInventoryCache.size > 200) partnerInventoryCache.clear();
  partnerInventoryCache.set(key, { at: Date.now(), items });
  return items;
}

// ---------------------------------------------------------------- send

export type OfferItem = { appid: number; contextid: string; assetid: string; amount: number };

export function requireOfferItems(value: unknown): OfferItem[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_ITEMS_PER_SIDE) throw new HttpError(400, `Не больше ${MAX_ITEMS_PER_SIDE} предметов с одной стороны.`);
  return value.map((i: any) => {
    const item = {
      appid: Number(i?.appid),
      contextid: String(i?.contextid ?? ""),
      assetid: String(i?.assetid ?? ""),
      amount: Math.max(1, Math.floor(Number(i?.amount) || 1))
    };
    if (!Number.isInteger(item.appid) || item.appid <= 0 || !/^\d{1,20}$/.test(item.contextid) || !/^\d{1,20}$/.test(item.assetid)) {
      throw new HttpError(400, "Неправильный предмет в обмене.");
    }
    return item;
  });
}

export async function sendTrade(session: SteamSession, opts: {
  link: unknown;
  give: OfferItem[];
  receive: OfferItem[];
  message?: string;
  partnerIsOwn: boolean;
  confirmGiveaway: boolean;
}) {
  const link = parseTradeLink(opts.link);
  sameAccount(session, link);
  requireIdentitySecret(session);
  if (opts.give.length === 0 && opts.receive.length === 0) throw new HttpError(400, "Обмен пустой: добавьте предметы.");
  // Giving to a stranger for nothing is the classic scam; the window asks first
  if (opts.give.length > 0 && opts.receive.length === 0 && !opts.partnerIsOwn && !opts.confirmGiveaway) {
    throw new HttpError(400, "Вы только отдаёте предметы чужому аккаунту. Подтвердите это в окне обмена.", "GIVEAWAY");
  }

  const offer = session.manager.createOffer(link.url);
  offer.addMyItems(opts.give);
  offer.addTheirItems(opts.receive);
  if (opts.message) offer.setMessage(String(opts.message).slice(0, MESSAGE_MAX));
  const status: string = await community(session.proxy, () => promisify((cb) => offer.send(cb)));
  const offerId = String(offer.id);
  session.ourOffers.set(offerId, link.steamId);

  // Confirmation is needed whenever we give something
  const note = status === "pending" ? await confirmOffer(session, offerId) : null;

  logEvent(session.uid, {
    level: "success",
    steamId: session.steamId,
    accountName: session.accountName,
    type: "trade-send",
    message: `Отправлен обмен #${offerId} → ${link.steamId}: отдаю ${opts.give.length}, получаю ${opts.receive.length}${note ? ` (${note})` : ""}`
  });
  return { offerId, status, note };
}

// ---------------------------------------------------------------- offers

const STATE = TradeOfferManager.ETradeOfferState;

function toOffer(session: SteamSession, offer: any) {
  return {
    id: String(offer.id),
    steamId: session.steamId,
    accountName: session.accountName,
    isOurOffer: !!offer.isOurOffer,
    fromApp: session.ourOffers.has(String(offer.id)),
    partnerSteamId: offer.partner.getSteamID64(),
    state: offer.state,
    stateName: STATE[offer.state] as string,
    message: offer.message || "",
    created: offer.created ? new Date(offer.created).getTime() : null,
    updated: offer.updated ? new Date(offer.updated).getTime() : null,
    expires: offer.expires ? new Date(offer.expires).getTime() : null,
    escrowEnds: offer.escrowEnds ? new Date(offer.escrowEnds).getTime() : null,
    itemsToGive: offer.itemsToGive.map(toItem),
    itemsToReceive: offer.itemsToReceive.map(toItem)
  };
}

export type TradeOfferView = ReturnType<typeof toOffer>;

export async function listOffers(session: SteamSession) {
  const cutoff = new Date(Date.now() - OFFER_HISTORY_DAYS * 24 * 60 * 60_000);
  // GetTradeOffers goes through the Web API (access token), not steamcommunity.com
  const { sent, received } = await new Promise<{ sent: any[]; received: any[] }>((resolve, reject) =>
    session.manager.getOffers(TradeOfferManager.EOfferFilter.All, cutoff, (err: any, s: any[], r: any[]) =>
      err ? reject(new HttpError(String(err.message).includes("429") ? 429 : 502, err.message)) : resolve({ sent: s, received: r })
    )
  );
  return [...sent, ...received]
    .map((o) => toOffer(session, o))
    .sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0))
    .slice(0, 100);
}

export async function offerAction(session: SteamSession, offerId: string, action: "accept" | "decline" | "cancel") {
  const offer: any = await getOffer(session, offerId);
  if (offer.state !== STATE.Active && !(action === "cancel" && offer.state === STATE.CreatedNeedsConfirmation)) {
    throw new HttpError(409, "Этот обмен уже не активен.");
  }
  if (action === "accept" && offer.isOurOffer) throw new HttpError(400, "Свой обмен принять нельзя, его принимает партнёр.");
  if (action === "cancel" && !offer.isOurOffer) throw new HttpError(400, "Входящий обмен можно только отклонить.");

  let note: string | null = null;
  if (action === "accept") {
    const status: string = await community(session.proxy, () => promisify((cb) => offer.accept(cb)));
    // Giving items needs the phone confirmation; the user just approved this exact offer
    if (status === "pending") note = await confirmOffer(session, offerId);
  } else {
    await community(session.proxy, () => promisify((cb) => offer.decline(cb)));
  }

  logEvent(session.uid, {
    level: action === "accept" ? "success" : "warning",
    steamId: session.steamId,
    accountName: session.accountName,
    type: `trade-${action}`,
    message: `${action === "accept" ? "Принят" : action === "decline" ? "Отклонён" : "Отменён"} обмен #${offerId} с ${offer.partner.getSteamID64()}${note ? ` (${note})` : ""}`
  });
  return { note };
}

export async function myTradeLink(session: SteamSession) {
  const token: string = await community(session.proxy, () => promisify((cb) => session.manager.getOfferToken(cb)));
  return { link: tradeLinkFor(session.steamId, token) };
}

// ---------------------------------------------------------------- events

const STATE_TEXT: Record<number, string> = {
  [STATE.Accepted]: "принят",
  [STATE.Declined]: "отклонён",
  [STATE.Canceled]: "отменён",
  [STATE.Expired]: "истёк",
  [STATE.Countered]: "получено контрпредложение",
  [STATE.InvalidItems]: "предметы больше недоступны",
  [STATE.InEscrow]: "на удержании (trade hold)",
  [STATE.CanceledBySecondFactor]: "отменён в подтверждениях"
};

// Writes offer state changes into the history and tells the window; `onIncoming`
// gets each new incoming offer (for a Windows notification)
export function watchTrades(onChange: () => void, onIncoming: (offer: TradeOfferView) => void) {
  onTradeEvent((session, kind, offer) => {
    const view = toOffer(session, offer);
    if (kind === "new") {
      logEvent(session.uid, {
        level: "info",
        steamId: session.steamId,
        accountName: session.accountName,
        type: "trade-incoming",
        message: `Входящий обмен #${view.id} от ${view.partnerSteamId}: отдаёте ${view.itemsToGive.length}, получаете ${view.itemsToReceive.length}`
      });
      onIncoming(view);
    } else if (STATE_TEXT[offer.state]) {
      logEvent(session.uid, {
        level: offer.state === STATE.Accepted ? "success" : "warning",
        steamId: session.steamId,
        accountName: session.accountName,
        type: "trade-state",
        message: `Обмен #${view.id} ${STATE_TEXT[offer.state]}`
      });
    }
    onChange();
  });
}
