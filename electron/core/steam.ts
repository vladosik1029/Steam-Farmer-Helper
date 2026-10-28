import SteamUser from "steam-user";
import SteamCommunity from "steamcommunity";
import TradeOfferManager from "steam-tradeoffer-manager";
import { LoginSession, EAuthTokenPlatformType } from "steam-session";
import axios from "axios";
import { HttpError } from "./security.ts";
import { getProxyAgent, proxyOptions, axiosProxy } from "./proxy.ts";
import { logEvent } from "./events.ts";
import { authCode, confirmationKey } from "./time.ts";
import { community } from "./community.ts";

export type SteamSession = {
  uid: string;
  accountName: string;
  steamId: string;
  user: SteamUser;
  community: SteamCommunity;
  manager: any;
  cookies: string[];
  loggedIn: boolean;
  proxy?: string;
  // Kept in memory only, needed for mobile confirmations
  identitySecret?: string;
  automation: boolean;
  connectedAt: number;
  lastError?: string;
  // Offers this app created (offer id -> partner SteamID); their mobile
  // confirmations are approved automatically if the partner still matches
  ourOffers: Map<string, string>;
};

// Trade offer events of every session (new incoming offer, state changes),
// for the trades page and notifications
export type TradeEventKind = "new" | "sent-changed" | "received-changed";
type TradeListener = (session: SteamSession, kind: TradeEventKind, offer: any) => void;
const tradeListeners = new Set<TradeListener>();

export function onTradeEvent(listener: TradeListener) {
  tradeListeners.add(listener);
  return () => tradeListeners.delete(listener);
}

const emitTrade = (session: SteamSession, kind: TradeEventKind, offer: any) => {
  for (const listener of tradeListeners) {
    try { listener(session, kind, offer); } catch (err: any) { console.error("[Trades]", err.message); }
  }
};

// Keyed by `${uid}:${steamId}` so one site user can never use another user's Steam session
const steamSessions = new Map<string, SteamSession>();
const sessionKey = (uid: string, steamId: string) => `${uid}:${steamId}`;

export function getSession(uid: string, steamId: string) {
  return steamSessions.get(sessionKey(uid, steamId));
}

export function requireSession(uid: string, steamId: string) {
  const session = getSession(uid, steamId);
  if (!session || !session.loggedIn) {
    throw new HttpError(409, "Аккаунт не подключён. Нажмите «Войти» на карточке.", "NOT_CONNECTED");
  }
  return session;
}

export function allSessions() {
  return [...steamSessions.values()];
}

export function listSessions(uid: string) {
  return [...steamSessions.values()]
    .filter((s) => s.uid === uid)
    .map((s) => ({
      steamId: s.steamId,
      accountName: s.accountName,
      loggedIn: s.loggedIn,
      automation: s.automation,
      connectedAt: s.connectedAt,
      lastError: s.lastError || null,
      canConfirm: !!s.identitySecret
    }));
}

export const promisify = <T>(fn: (cb: (err: any, result: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, result) => (err ? reject(err) : resolve(result))));

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

// Interactive login with password + Steam Guard code; returns a long-lived refresh token
export async function obtainRefreshToken(accountName: string, password: string, sharedSecret?: string, proxy?: string) {
  const login = new LoginSession(EAuthTokenPlatformType.SteamClient, proxyOptions(proxy) as any);

  return new Promise<{ refreshToken: string; steamId: string }>((resolve, reject) => {
    const fail = (err: Error) => {
      clearTimeout(timer);
      try { login.cancelLoginAttempt(); } catch {}
      reject(err);
    };
    const timer = setTimeout(() => fail(new HttpError(504, "Steam login timeout (60s).")), 60000);

    login.once("authenticated", () => {
      clearTimeout(timer);
      resolve({ refreshToken: login.refreshToken, steamId: login.steamID.getSteamID64() });
    });
    login.once("timeout", () => fail(new HttpError(504, "Steam login timed out.")));
    login.once("error", (err: any) => fail(new HttpError(401, `Steam: ${err.message}`)));

    login.startWithCredentials({
      accountName,
      password,
      steamGuardCode: sharedSecret ? authCode(sharedSecret).code : undefined
    }).then((result) => {
      if (result.actionRequired) {
        const types = (result.validActions || []).map((a: any) => a.type).join(", ");
        fail(new HttpError(401, `Steam Guard требует подтверждения (${types}). Импортируйте maFile с shared_secret.`));
      }
    }).catch((err: any) => {
      const msg = err.message === "InvalidPassword" ? "Неверный пароль Steam." : `Steam: ${err.message}`;
      fail(new HttpError(401, msg));
    });
  });
}

function createSteamSession(uid: string, accountName: string, proxy?: string): SteamSession {
  const community = new SteamCommunity();
  if (proxy) {
    // steamcommunity has no setAgent(); wrap its `request` instance with a proxy agent
    (community as any).request = (community as any).request.defaults({ agent: getProxyAgent(proxy) });
  }
  const user = new SteamUser({ ...proxyOptions(proxy), renewRefreshTokens: true } as any);
  const manager = new TradeOfferManager({
    steam: user,
    community,
    language: "en",
    pollInterval: 30000,
    useAccessToken: true
  });

  const session: SteamSession = {
    uid,
    accountName,
    steamId: "",
    user,
    community,
    manager,
    cookies: [],
    loggedIn: false,
    proxy,
    automation: false,
    connectedAt: Date.now(),
    ourOffers: new Map()
  };

  // Permanent listeners: an 'error' event without a listener would crash the whole server
  user.on("error", (err: any) => {
    console.error(`[Steam] ${accountName} session error:`, err.message);
    session.loggedIn = false;
    session.lastError = err.message;
  });
  user.on("webSession", (_sessionID: string, cookies: string[]) => {
    session.cookies = cookies;
    community.setCookies(cookies);
    manager.setCookies(cookies, (err: any) => {
      if (err) console.error(`[Steam] ${accountName} trade manager cookies:`, err.message);
    });
    session.loggedIn = true;
    session.lastError = undefined;
  });
  // Web cookies expire every ~24h; ask steam-user for fresh ones
  community.on("sessionExpired", () => {
    try { user.webLogOn(); } catch {}
  });
  manager.on("pollFailure", (err: any) => {
    session.lastError = `Trade polling: ${err.message}`;
  });
  // Incoming offers are only reported here; accepting is up to the user (or the
  // automation tick for gifts), so the same offer is never accepted twice
  manager.on("newOffer", (offer: any) => emitTrade(session, "new", offer));
  manager.on("sentOfferChanged", (offer: any) => emitTrade(session, "sent-changed", offer));
  manager.on("receivedOfferChanged", (offer: any) => emitTrade(session, "received-changed", offer));

  return session;
}

// Logs steam-user on with a refresh token (no password). Resolves on the first web session.
function connectWithRefreshToken(session: SteamSession, refreshToken: string) {
  return new Promise<{ steamId: string; renewedToken?: string }>((resolve, reject) => {
    let renewedToken: string | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      session.user.removeListener("webSession", onWebSession);
      session.user.removeListener("error", onError);
      session.user.removeListener("refreshToken", onRefreshToken);
    };
    const onWebSession = () => {
      cleanup();
      resolve({ steamId: session.user.steamID!.getSteamID64(), renewedToken });
    };
    const onError = (err: any) => {
      cleanup();
      const expired = ["InvalidPassword", "AccessDenied", "Expired", "Revoked", "InvalidSignature"]
        .some((s) => String(err.message).includes(s));
      reject(expired
        ? new HttpError(401, "Steam-токен истёк или отозван. Введите пароль в настройках аккаунта.", "REAUTH_REQUIRED")
        : new HttpError(502, `Steam: ${err.message}`));
    };
    const onRefreshToken = (token: string) => {
      renewedToken = token;
    };
    const timer = setTimeout(() => {
      cleanup();
      try { session.user.logOff(); } catch {}
      reject(new HttpError(504, "Steam login timeout (60s)."));
    }, 60000);

    session.user.on("webSession", onWebSession);
    session.user.on("error", onError);
    session.user.on("refreshToken", onRefreshToken);

    try {
      session.user.logOn({ refreshToken } as any);
    } catch (err: any) {
      onError(err);
    }
  });
}

export async function connectSession(opts: {
  uid: string;
  accountName: string;
  refreshToken: string;
  identitySecret?: string;
  proxy?: string;
  automation?: boolean;
  steamIdHint?: string;
}) {
  // Reuse a live session for the same account and proxy
  if (opts.steamIdHint) {
    const existing = getSession(opts.uid, opts.steamIdHint);
    if (existing?.loggedIn && (existing.proxy || "") === (opts.proxy || "")) {
      existing.identitySecret = opts.identitySecret || existing.identitySecret;
      if (opts.automation !== undefined) existing.automation = opts.automation;
      return { session: existing, renewedToken: undefined };
    }
  }

  console.log(`[Steam] Connecting ${opts.accountName} via refresh token`);
  const session = createSteamSession(opts.uid, opts.accountName, opts.proxy);
  const { steamId, renewedToken } = await connectWithRefreshToken(session, opts.refreshToken);
  session.steamId = steamId;
  session.identitySecret = opts.identitySecret;
  session.automation = !!opts.automation;

  const key = sessionKey(opts.uid, steamId);
  const previous = steamSessions.get(key);
  if (previous && previous !== session) disconnectSession(previous);
  steamSessions.set(key, session);

  return { session, renewedToken };
}

export function disconnectSession(session: SteamSession) {
  session.loggedIn = false;
  try { session.manager.shutdown(); } catch {}
  try { session.user.logOff(); } catch {}
  steamSessions.delete(sessionKey(session.uid, session.steamId));
}

// ---------------------------------------------------------------------------
// Account data
// ---------------------------------------------------------------------------

export async function fetchSteamWallet(session: SteamSession) {
  // steamcommunity has no getWalletBalance(); steam-user receives wallet info over the CM connection
  const wallet = await new Promise<any>((resolve) => {
    if ((session.user as any).wallet) return resolve((session.user as any).wallet);
    const timer = setTimeout(() => resolve(null), 5000);
    session.user.once("wallet", (hasWallet: boolean, currency: number, balance: number) => {
      clearTimeout(timer);
      resolve({ hasWallet, currency, balance });
    });
  });

  if (!wallet) {
    return { balance: "0.00", currency: "USD", loggedIn: true, error: "Wallet info not received from Steam" };
  }

  const currencyName = (SteamUser as any).ECurrencyCode?.[wallet.currency] || "USD";
  return { balance: Number(wallet.balance).toFixed(2), currency: currencyName, loggedIn: true };
}

// Public profile (name, avatar, VAC) + full ban info when we have an access token
export async function fetchProfile(steamId: string, session?: SteamSession, proxy?: string) {
  const response = await community(proxy, () => axios.get(`https://steamcommunity.com/profiles/${steamId}?xml=1`, {
    timeout: 15000,
    ...axiosProxy(proxy)
  }));
  const xml = String(response.data);
  const pick = (tag: string) => {
    const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`, "s"));
    return m ? m[1] : "";
  };

  const profile: Record<string, unknown> = {
    personaName: pick("steamID"),
    avatar: pick("avatarFull"),
    vacBanned: pick("vacBanned") === "1",
    tradeBanState: pick("tradeBanState") || "None",
    isLimitedAccount: pick("isLimitedAccount") === "1"
  };

  // GetPlayerBans needs a Web API key, so VAC/game ban counters are read from the
  // profile page's "profile_ban_status" block (shown even on private profiles)
  try {
    const page = await community(proxy || session?.proxy, () => axios.get(`https://steamcommunity.com/profiles/${steamId}`, {
      timeout: 15000,
      headers: { Cookie: "Steam_Language=english" },
      ...axiosProxy(proxy || session?.proxy)
    }), "low");
    const html = String(page.data);
    const num = (re: RegExp) => Number(html.match(re)?.[1] || 0);
    const multipleVac = /Multiple VAC bans on record/i.test(html);
    profile.vacBans = multipleVac ? Math.max(2, num(/(\d+)\s+VAC bans? on record/i)) : num(/(\d+)\s+VAC bans? on record/i);
    profile.gameBans = num(/(\d+)\s+game bans? on record/i);
    const days = html.match(/(\d+)\s+day\(s\) since last ban/i);
    if (days) profile.daysSinceLastBan = Number(days[1]);
    if ((profile.vacBans as number) > 0) profile.vacBanned = true;
  } catch (err: any) {
    console.warn(`[Steam] Ban status for ${steamId} unavailable:`, err.message);
  }

  return profile;
}

// Identical concurrent requests share one Steam call: Steam rejects the second one as "duplicate"
const inflightInventory = new Map<string, Promise<any[]>>();

export function fetchSteamInventory(session: SteamSession | undefined, steamId: string, appId: number, contextId: number, proxy?: string) {
  const key = `${session?.uid || "anon"}:${steamId}:${appId}:${contextId}`;
  const existing = inflightInventory.get(key);
  if (existing) return existing;
  const promise = loadSteamInventory(session, steamId, appId, contextId, proxy)
    .finally(() => inflightInventory.delete(key));
  inflightInventory.set(key, promise);
  return promise;
}

async function loadSteamInventory(session: SteamSession | undefined, steamId: string, appId: number, contextId: number, proxy?: string): Promise<any[]> {
  if (session && session.loggedIn) {
    return community(session.proxy, () => new Promise<any[]>((resolve, reject) => {
      // tradableOnly = false: otherwise trade-locked / non-tradable items are silently dropped
      session.community.getUserInventoryContents(steamId, appId, contextId, false, "english", (err: any, inventory: any) => {
        if (err) return reject(new HttpError(String(err.message).includes("429") ? 429 : 502, err.message));
        resolve(inventory);
      });
    }));
  }

  // Anonymous fallback: Steam rate-limits this heavily, logging in is strongly preferred
  const response = await community(proxy, () => axios.get(`https://steamcommunity.com/inventory/${steamId}/${appId}/${contextId}?l=english&count=2000`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Referer": `https://steamcommunity.com/profiles/${steamId}/inventory/`
    },
    timeout: 30000,
    validateStatus: (status) => status !== 429,
    ...axiosProxy(proxy)
  }));

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(401, "Steam не отдаёт инвентарь без входа. Нажмите «Войти» на аккаунте.");
  }
  if (response.status !== 200) {
    throw new HttpError(502, `Steam HTTP error ${response.status}`);
  }

  const data = response.data;
  if (data && data.success === false) {
    throw new HttpError(502, data.error || "Steam сообщил о неудаче при загрузке инвентаря.");
  }
  if (!data || !data.assets) return [];

  const descriptions = new Map<string, any>();
  for (const d of data.descriptions || []) descriptions.set(`${d.classid}_${d.instanceid}`, d);
  return data.assets.map((asset: any) => {
    const d = descriptions.get(`${asset.classid}_${asset.instanceid}`) || {};
    return { ...asset, ...d, id: asset.assetid, tradable: !!d.tradable, marketable: !!d.marketable };
  });
}

// ---------------------------------------------------------------------------
// Mobile confirmations
// ---------------------------------------------------------------------------

export function requireIdentitySecret(session: SteamSession) {
  if (!session.identitySecret) {
    throw new HttpError(400, "В maFile нет identity_secret, подтверждения недоступны.");
  }
  return session.identitySecret;
}

export async function listConfirmations(session: SteamSession) {
  const { time, key } = confirmationKey(requireIdentitySecret(session), "conf");
  return community(session.proxy, () => promisify<any[]>((cb) => session.community.getConfirmations(time, key, cb)));
}

export async function respondToConfirmation(session: SteamSession, conf: any, accept: boolean) {
  const { time, key } = confirmationKey(requireIdentitySecret(session), accept ? "allow" : "cancel");
  await community(session.proxy, () => promisify((cb) => conf.respond(time, key, accept, cb)));
}

// Confirms a sent offer on the phone side. Returns a note instead of throwing:
// the offer is already out, and the Steam Guard poll can still confirm it.
export async function confirmOffer(session: SteamSession, offerId: string): Promise<string | null> {
  try {
    const confs = await listConfirmations(session);
    const conf = confs.find((c) => String(c.creator) === offerId);
    if (!conf) return "подтверждение ещё не появилось, подтвердите его в разделе Steam Guard";
    await respondToConfirmation(session, conf, true);
    return null;
  } catch (err: any) {
    return `не подтверждён сразу (${err.message}), подтвердите его в разделе Steam Guard`;
  }
}

export function getOffer(session: SteamSession, offerId: string) {
  return promisify<any>((cb) => session.manager.getOffer(offerId, cb));
}

// ---------------------------------------------------------------------------
// Trade offers
// ---------------------------------------------------------------------------

// "Safe" = we give nothing away
async function acceptIfSafe(session: SteamSession, offer: any) {
  if (offer.isOurOffer || offer.itemsToGive.length > 0) return false;
  const status: string = await community(session.proxy, () => promisify((cb) => offer.accept(cb)));
  logEvent(session.uid, {
    level: "success",
    steamId: session.steamId,
    accountName: session.accountName,
    type: "trade-accept",
    message: `Принят безопасный трейд #${offer.id} от ${offer.partner.getSteamID64()}: +${offer.itemsToReceive.length} предм. (${status})`
  });
  return true;
}

export async function acceptSafeOffers(session: SteamSession) {
  const { received } = await new Promise<{ received: any[] }>((resolve, reject) =>
    session.manager.getOffers(TradeOfferManager.EOfferFilter.ActiveOnly, (err: any, _sent: any[], received: any[]) =>
      err ? reject(new HttpError(502, err.message)) : resolve({ received })
    )
  );
  const active = received.filter((o) => o.state === TradeOfferManager.ETradeOfferState.Active);
  let accepted = 0;
  for (const offer of active) {
    try {
      if (await acceptIfSafe(session, offer)) accepted++;
    } catch (err: any) {
      logEvent(session.uid, {
        level: "error",
        steamId: session.steamId,
        accountName: session.accountName,
        type: "trade-error",
        message: `Трейд #${offer.id}: ${err.message}`
      });
    }
  }
  return { active: active.length, accepted, skipped: active.length - accepted };
}

export type TransferItem = { assetid: string; amount: number };

// Sends items from one connected account to another, confirms on the sender
// and accepts on the receiver. No items = all tradable items of that app/context.
// A step that fails after the offer is sent doesn't fail the transfer: the
// Steam Guard poll confirms the app's own offers, and the offer can still be
// accepted later.
export async function transferItems(from: SteamSession, to: SteamSession, appId: number, contextId: number, picked: TransferItem[]) {
  if (from.steamId === to.steamId) throw new HttpError(400, "Нельзя передать предметы самому себе.");
  requireIdentitySecret(from);

  const token: string = await community(to.proxy, () => promisify((cb) => to.manager.getOfferToken(cb)));
  // Selected items are already known to the window: no extra inventory request
  const items = picked.length > 0
    ? picked.map((i) => ({ appid: appId, contextid: String(contextId), assetid: i.assetid, amount: i.amount }))
    : await community(from.proxy, () => promisify<any[]>((cb) => from.manager.getInventoryContents(appId, contextId, true, cb)));
  if (items.length === 0) {
    return { offerId: null, items: 0, status: "nothing-to-send", notes: [] as string[] };
  }

  const offer = from.manager.createOffer(to.steamId, token);
  offer.addMyItems(items);
  offer.setMessage("SteamFarmer: перенос предметов");
  const status: string = await community(from.proxy, () => promisify((cb) => offer.send(cb)));
  const offerId = String(offer.id);
  from.ourOffers.set(offerId, to.steamId);

  const notes: string[] = [];
  if (status === "pending") {
    // Our own transfer: the Guard poll confirms it later if this attempt fails
    const note = await confirmOffer(from, offerId);
    if (note) notes.push(note.replace("подтвердите его в разделе Steam Guard", "приложение подтвердит его само"));
  }

  // Receiver gives nothing, so accepting is always safe
  try {
    const incoming: any = await promisify((cb) => to.manager.getOffer(offerId, cb));
    await community(to.proxy, () => promisify((cb) => incoming.accept(cb)));
  } catch (err: any) {
    notes.push(`не принят на ${to.accountName} (${err.message}), примите обмен позже`);
    logEvent(to.uid, {
      level: "warning",
      steamId: to.steamId,
      accountName: to.accountName,
      type: "transfer",
      message: `Трейд #${offerId} отправлен, но не принят автоматически: ${err.message}`
    });
  }

  logEvent(from.uid, {
    level: "success",
    steamId: from.steamId,
    accountName: from.accountName,
    type: "transfer",
    message: `Передано ${items.length} предм. → ${to.accountName} (трейд #${offerId})`
  });
  return { offerId, items: items.length, status, notes };
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

export async function addFreeLicenses(session: SteamSession, appIds: number[]) {
  const result: any = await (session.user as any).requestFreeLicense(appIds);
  const grantedApps: number[] = result?.grantedAppIds || [];
  const grantedPackages: number[] = result?.grantedPackageIds || [];
  logEvent(session.uid, {
    level: grantedApps.length || grantedPackages.length ? "success" : "warning",
    steamId: session.steamId,
    accountName: session.accountName,
    type: "free-license",
    message: grantedApps.length || grantedPackages.length
      ? `Добавлены игры: ${grantedApps.join(", ") || grantedPackages.join(", ")}`
      : `Steam ничего не выдал для ${appIds.join(", ")} (уже есть или не бесплатно)`
  });
  return { grantedApps, grantedPackages };
}

// ---------------------------------------------------------------------------
// Automation loop: every 30s accept safe incoming trades (confirmations are handled by guard.ts)
// ---------------------------------------------------------------------------

const AUTOMATION_INTERVAL_MS = 30_000;

async function runAutomationTick() {
  for (const session of steamSessions.values()) {
    if (!session.automation || !session.loggedIn) continue;
    try {
      await acceptSafeOffers(session);
      session.lastError = undefined;
    } catch (err: any) {
      session.lastError = `Автоматизация: ${err.message}`;
    }
  }
}

setInterval(() => {
  runAutomationTick().catch((err) => console.error("[Automation]", err.message));
}, AUTOMATION_INTERVAL_MS).unref();
