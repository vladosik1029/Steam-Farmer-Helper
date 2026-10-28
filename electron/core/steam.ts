import SteamUser from "steam-user";
import SteamCommunity from "steamcommunity";
import TradeOfferManager from "steam-tradeoffer-manager";
import { LoginSession, EAuthTokenPlatformType } from "steam-session";
import axios from "axios";
import { HttpError } from "./security.ts";
import { getProxyAgent, proxyOptions, axiosProxy } from "./proxy.ts";
import { logEvent } from "./events.ts";
import { authCode, confirmationKey } from "./time.ts";

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

const promisify = <T>(fn: (cb: (err: any, result: T) => void) => void) =>
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
  // Incoming offers are handled by the automation tick (acceptSafeOffers), not by 'newOffer',
  // so the same offer is never accepted twice

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
  const response = await axios.get(`https://steamcommunity.com/profiles/${steamId}?xml=1`, {
    timeout: 15000,
    ...axiosProxy(proxy)
  });
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
    const page = await axios.get(`https://steamcommunity.com/profiles/${steamId}`, {
      timeout: 15000,
      headers: { Cookie: "Steam_Language=english" },
      ...axiosProxy(proxy || session?.proxy)
    });
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
    return new Promise<any[]>((resolve, reject) => {
      // tradableOnly = false: otherwise trade-locked / non-tradable items are silently dropped
      session.community.getUserInventoryContents(steamId, appId, contextId, false, "english", (err: any, inventory: any) => {
        if (err) return reject(new HttpError(502, err.message));
        resolve(inventory);
      });
    });
  }

  // Anonymous fallback: Steam rate-limits this heavily, logging in is strongly preferred
  const response = await axios.get(`https://steamcommunity.com/inventory/${steamId}/${appId}/${contextId}?l=english&count=2000`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Referer": `https://steamcommunity.com/profiles/${steamId}/inventory/`
    },
    timeout: 30000,
    validateStatus: () => true,
    ...axiosProxy(proxy)
  });

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(401, "Steam не отдаёт инвентарь без входа. Нажмите «Войти» на аккаунте.");
  }
  if (response.status === 429) {
    throw new HttpError(429, "Слишком много запросов (429). Подождите 5-10 минут или войдите в аккаунт.");
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

function requireIdentitySecret(session: SteamSession) {
  if (!session.identitySecret) {
    throw new HttpError(400, "В maFile нет identity_secret, подтверждения недоступны.");
  }
  return session.identitySecret;
}

export async function listConfirmations(session: SteamSession) {
  const { time, key } = confirmationKey(requireIdentitySecret(session), "conf");
  const confs: any[] = await promisify((cb) => session.community.getConfirmations(time, key, cb));
  return confs;
}

export async function respondToConfirmation(session: SteamSession, conf: any, accept: boolean) {
  const { time, key } = confirmationKey(requireIdentitySecret(session), accept ? "allow" : "cancel");
  await promisify((cb) => conf.respond(time, key, accept, cb));
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
  const status: string = await promisify((cb) => offer.accept(cb));
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

// Sends items from one connected account to another, confirms on the sender
// and accepts on the receiver. assetIds empty = all tradable items of that app/context.
export async function transferItems(from: SteamSession, to: SteamSession, appId: number, contextId: number, assetIds: string[]) {
  if (from.steamId === to.steamId) throw new HttpError(400, "Нельзя передать предметы самому себе.");
  requireIdentitySecret(from);

  const token: string = await promisify((cb) => to.manager.getOfferToken(cb));
  const inventory: any[] = await promisify((cb) => from.manager.getInventoryContents(appId, contextId, true, cb));
  const items = assetIds.length > 0 ? inventory.filter((i) => assetIds.includes(String(i.assetid))) : inventory;
  if (items.length === 0) {
    return { offerId: null, items: 0, status: "nothing-to-send" };
  }

  const offer = from.manager.createOffer(to.steamId, token);
  offer.addMyItems(items);
  offer.setMessage("SteamFarmer: перенос предметов");
  const status: string = await promisify((cb) => offer.send(cb));
  from.ourOffers.set(String(offer.id), to.steamId);

  if (status === "pending") {
    await promisify((cb) => from.community.acceptConfirmationForObject(from.identitySecret!, offer.id, cb));
  }

  // Receiver gives nothing, so accepting is always safe
  try {
    const incoming: any = await promisify((cb) => to.manager.getOffer(offer.id, cb));
    await promisify((cb) => incoming.accept(cb));
  } catch (err: any) {
    logEvent(to.uid, {
      level: "warning",
      steamId: to.steamId,
      accountName: to.accountName,
      type: "transfer",
      message: `Трейд #${offer.id} отправлен, но не принят автоматически: ${err.message}`
    });
  }

  logEvent(from.uid, {
    level: "success",
    steamId: from.steamId,
    accountName: from.accountName,
    type: "transfer",
    message: `Передано ${items.length} предм. → ${to.accountName} (трейд #${offer.id})`
  });
  return { offerId: String(offer.id), items: items.length, status };
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
