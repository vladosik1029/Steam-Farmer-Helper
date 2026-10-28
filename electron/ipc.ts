import { ipcMain, type IpcMainInvokeEvent } from "electron";
import SteamTotp from "steam-totp";
import axios from "axios";
import {
  HttpError, seal, unseal, tokenExpiry,
  requireSteamId, requireAccountName, requireIdList, type AccountSecrets
} from "./core/security.ts";
import { normalizeProxy, getProxyAgent } from "./core/proxy.ts";
import {
  obtainRefreshToken, connectSession, disconnectSession, getSession, requireSession, listSessions,
  fetchSteamWallet, fetchProfile, fetchSteamInventory, listConfirmations, confirmAutomatic,
  respondToConfirmations, acceptSafeOffers, transferItems, addFreeLicenses
} from "./core/steam.ts";
import { getPrices } from "./core/prices.ts";
import { findFreePromotions } from "./core/games.ts";
import * as store from "./store.ts";
import { importLegacyExport } from "./migrate.ts";

// The desktop app has one local profile; the core still keys sessions and
// sealed blobs by owner, so everything belongs to this one.
export const LOCAL_UID = "local";
const uid = LOCAL_UID;

type Handler = (body: any) => Promise<any> | any;

// Same names and payloads as the old Express routes (/api/<name>), so the
// interface code barely changed.
const api: Record<string, Handler> = {
  // ---------------------------------------------------------------- accounts

  // Encrypt account secrets. With a password it also logs in once and stores a refresh token,
  // so the password itself is never saved anywhere.
  "accounts/seal": async (body) => {
    const { password, sharedSecret, identitySecret, revocationCode, sealed } = body;
    const accountName = requireAccountName(body.accountName);
    const proxy = normalizeProxy(body.proxy);

    const secrets: AccountSecrets = sealed ? unseal(sealed, uid) : {};
    if (sharedSecret) secrets.sharedSecret = String(sharedSecret);
    if (identitySecret) secrets.identitySecret = String(identitySecret);
    if (revocationCode) secrets.revocationCode = String(revocationCode);

    let steamId: string | undefined;
    if (password) {
      console.log(`[Steam] Obtaining refresh token for ${accountName}`);
      const result = await obtainRefreshToken(accountName, String(password), secrets.sharedSecret, proxy);
      secrets.refreshToken = result.refreshToken;
      steamId = result.steamId;
    }

    return {
      sealed: seal(secrets, uid),
      steamId,
      hasToken: !!secrets.refreshToken,
      tokenExpires: tokenExpiry(secrets.refreshToken)
    };
  },

  // Start (or restore) a Steam session from the stored refresh token
  "steam/connect": async (body) => {
    const accountName = requireAccountName(body.accountName);
    const proxy = normalizeProxy(body.proxy);
    const secrets = unseal(body.sealed, uid);

    if (!secrets.refreshToken) {
      throw new HttpError(401, "Нет Steam-токена. Введите пароль в настройках аккаунта.", "REAUTH_REQUIRED");
    }

    const { session, renewedToken } = await connectSession({
      uid,
      accountName,
      refreshToken: secrets.refreshToken,
      identitySecret: secrets.identitySecret,
      proxy,
      automation: !!body.automation,
      steamIdHint: body.steamId ? String(body.steamId) : undefined
    });

    let resealed: string | undefined;
    if (renewedToken) {
      secrets.refreshToken = renewedToken;
      resealed = seal(secrets, uid);
    }

    return {
      success: true,
      steamId: session.steamId,
      sealed: resealed,
      tokenExpires: tokenExpiry(secrets.refreshToken)
    };
  },

  "steam/disconnect": (body) => {
    const session = getSession(uid, requireSteamId(body.steamId));
    if (session) disconnectSession(session);
    return { success: true };
  },

  // Which accounts currently have a live session (active / stale status in the UI)
  "steam/sessions": () => ({ sessions: listSessions(uid) }),

  "steam/automation": (body) => {
    const session = requireSession(uid, requireSteamId(body.steamId));
    session.automation = !!body.enabled;
    return { success: true, automation: session.automation };
  },

  "steam/wallet": async (body) => {
    const session = getSession(uid, requireSteamId(body.steamId));
    if (!session || !session.loggedIn) return { balance: "0.00", currency: "USD", loggedIn: false };
    return fetchSteamWallet(session);
  },

  "steam/code": (body) => {
    const secrets = unseal(body.sealed, uid);
    if (!secrets.sharedSecret) throw new HttpError(400, "No shared_secret for this account");
    return { code: SteamTotp.getAuthCode(secrets.sharedSecret), validFor: 30 - (SteamTotp.time() % 30) };
  },

  "steam/profile": (body) => {
    const steamId = requireSteamId(body.steamId);
    return fetchProfile(steamId, getSession(uid, steamId), normalizeProxy(body.proxy));
  },

  // ---------------------------------------------------------------- inventory & prices

  "steam/inventory": async (body) => {
    const steamId = requireSteamId(body.steamId);
    const appId = Number(body.appId) || 730;
    const contextId = Number(body.contextId) || (appId === 753 ? 6 : 2);
    const session = getSession(uid, steamId);
    console.log(`[Steam] Inventory ${steamId} app ${appId}/${contextId}${session?.loggedIn ? " (session)" : " (anonymous)"}`);
    return { inventory: await fetchSteamInventory(session, steamId, appId, contextId, normalizeProxy(body.proxy)) };
  },

  "prices": (body) => {
    const raw = Array.isArray(body.items) ? body.items : [];
    if (raw.length > 1000) throw new HttpError(400, "Too many items (max 1000)");
    const items = raw
      .map((i: any) => ({ appId: Number(i.appId) || 730, name: String(i.name || "").slice(0, 200) }))
      .filter((i: any) => i.name);
    return getPrices(items);
  },

  // ---------------------------------------------------------------- automation & trades

  "steam/confirmations": async (body) => {
    const session = requireSession(uid, requireSteamId(body.steamId));
    const confs = await listConfirmations(session);
    return {
      confirmations: confs.map((c: any) => ({
        id: String(c.id),
        type: c.type,
        title: c.title,
        sending: c.sending,
        receiving: c.receiving,
        time: c.timestamp,
        icon: c.icon,
        ours: session.ourOfferIds.has(String(c.creator))
      }))
    };
  },

  "steam/confirmations/respond": (body) => {
    const session = requireSession(uid, requireSteamId(body.steamId));
    return respondToConfirmations(session, requireIdList(body.ids, 200), body.accept !== false);
  },

  // One-shot run of what the automation toggle does in the background
  "steam/confirmations/auto": (body) => confirmAutomatic(requireSession(uid, requireSteamId(body.steamId))),

  "steam/offers/accept-safe": (body) => acceptSafeOffers(requireSession(uid, requireSteamId(body.steamId))),

  "steam/transfer": (body) => {
    const from = requireSession(uid, requireSteamId(body.fromSteamId));
    const to = requireSession(uid, requireSteamId(body.toSteamId));
    const appId = Number(body.appId) || 730;
    const contextId = Number(body.contextId) || (appId === 753 ? 6 : 2);
    return transferItems(from, to, appId, contextId, requireIdList(body.assetIds, 500));
  },

  // ---------------------------------------------------------------- games

  "games/free": async () => ({ games: await findFreePromotions() }),

  "games/add": (body) => {
    const session = requireSession(uid, requireSteamId(body.steamId));
    const appIds = requireIdList(body.appIds, 50).map(Number);
    if (appIds.length === 0) throw new HttpError(400, "No appIds");
    return addFreeLicenses(session, appIds);
  },

  // ---------------------------------------------------------------- misc

  "proxy/test": async (body) => {
    const proxy = normalizeProxy(body.proxy);
    if (!proxy) throw new HttpError(400, "No proxy provided");
    try {
      const response = await axios.get("https://api.ipify.org?format=json", {
        httpsAgent: getProxyAgent(proxy),
        proxy: false, // Critical for custom agents in Axios
        timeout: 20000
      });
      return { success: true, status: response.status, ip: response.data.ip };
    } catch (error: any) {
      let message = error.message;
      if (error.code === "ECONNRESET") message = "Connection Reset: The proxy closed the connection. Check your credentials or protocol (SOCKS vs HTTP).";
      if (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED") message = "Connection Timeout: The proxy is too slow or unresponsive.";
      throw new HttpError(502, message, error.code);
    }
  },

  // Accounts, proxies and history exported from the old web version
  "migrate/import": (body) => importLegacyExport(body.data, String(body.secretsKey || ""), uid)
};

// ---------------------------------------------------------------- local data

const COLLECTIONS = new Set(["accounts", "proxies", "logs"]);
const WRITABLE = new Set(["accounts", "proxies"]);

function requireCollection(value: unknown, writable = false) {
  const name = String(value);
  if (!(writable ? WRITABLE : COLLECTIONS).has(name)) throw new HttpError(400, `Unknown collection ${name}`);
  return name as store.Collection;
}

function requireDocId(value: unknown) {
  const id = String(value || "");
  if (!/^[\w.-]{1,128}$/.test(id)) throw new HttpError(400, "Invalid document id");
  return id;
}

const storeOps: Record<string, Handler> = {
  list: (body) => store.listDocs(requireCollection(body.collection)),
  set: (body) => store.setDoc(
    requireCollection(body.collection, true) as "accounts" | "proxies",
    requireDocId(body.id),
    body.data || {},
    { merge: !!body.merge, unset: Array.isArray(body.unset) ? body.unset.map(String) : [] }
  ),
  delete: (body) => store.deleteDoc(requireCollection(body.collection, true) as "accounts" | "proxies", requireDocId(body.id)),
  addLog: (body) => store.addLog({ ...body.entry, id: requireDocId(body.entry?.id) })
};

// Errors don't survive IPC with their fields, so they travel as a result
type Result = { ok: true; data: any } | { ok: false; error: string; status: number; code?: string };

async function run(handler: Handler | undefined, name: string, body: any): Promise<Result> {
  if (!handler) return { ok: false, error: `Unknown call ${name}`, status: 404 };
  try {
    return { ok: true, data: await handler(body ?? {}) };
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(`[IPC] ${name}:`, err.message);
    return { ok: false, error: err.message, status, code: err.code };
  }
}

export function registerIpc(isTrustedSender: (event: IpcMainInvokeEvent) => boolean) {
  ipcMain.handle("api", (event, name: string, body: any) => {
    if (!isTrustedSender(event)) return { ok: false, error: "Forbidden", status: 403 };
    return run(api[name], name, body);
  });
  ipcMain.handle("store", (event, op: string, body: any) => {
    if (!isTrustedSender(event)) return { ok: false, error: "Forbidden", status: 403 };
    return run(storeOps[op], `store/${op}`, body);
  });
}
