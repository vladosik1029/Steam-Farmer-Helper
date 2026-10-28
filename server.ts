import "./server/env.ts";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import SteamTotp from "steam-totp";
import axios from "axios";
import {
  HttpError, seal, unseal, tokenExpiry, requireAuth, rateLimit, handle,
  requireSteamId, requireAccountName, requireIdList, type AccountSecrets
} from "./server/security.ts";
import { normalizeProxy, getProxyAgent } from "./server/proxy.ts";
import {
  obtainRefreshToken, connectSession, disconnectSession, getSession, requireSession, listSessions,
  fetchSteamWallet, fetchProfile, fetchSteamInventory, listConfirmations, confirmAutomatic,
  respondToConfirmations, acceptSafeOffers, transferItems, addFreeLicenses
} from "./server/steam.ts";
import { getPrices } from "./server/prices.ts";
import { findFreePromotions } from "./server/games.ts";
import { getEvents } from "./server/events.ts";

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Everything below requires a signed-in site user
  app.use("/api", requireAuth);

  // ---------------------------------------------------------------- accounts

  // Encrypt account secrets. With a password it also logs in once and stores a refresh token,
  // so the password itself is never saved anywhere.
  app.post("/api/accounts/seal", rateLimit(10, 60_000), handle(async (req, res) => {
    const uid = res.locals.uid as string;
    const { password, sharedSecret, identitySecret, revocationCode, sealed } = req.body;
    const accountName = requireAccountName(req.body.accountName);
    const proxy = normalizeProxy(req.body.proxy);

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

    res.json({
      sealed: seal(secrets, uid),
      steamId,
      hasToken: !!secrets.refreshToken,
      tokenExpires: tokenExpiry(secrets.refreshToken)
    });
  }));

  // Start (or restore) a Steam session from the stored refresh token
  app.post("/api/steam/connect", rateLimit(30, 60_000), handle(async (req, res) => {
    const uid = res.locals.uid as string;
    const accountName = requireAccountName(req.body.accountName);
    const proxy = normalizeProxy(req.body.proxy);
    const secrets = unseal(req.body.sealed, uid);

    if (!secrets.refreshToken) {
      throw new HttpError(401, "Нет Steam-токена. Введите пароль в настройках аккаунта.", "REAUTH_REQUIRED");
    }

    const { session, renewedToken } = await connectSession({
      uid,
      accountName,
      refreshToken: secrets.refreshToken,
      identitySecret: secrets.identitySecret,
      proxy,
      automation: !!req.body.automation,
      steamIdHint: req.body.steamId ? String(req.body.steamId) : undefined
    });

    let resealed: string | undefined;
    if (renewedToken) {
      secrets.refreshToken = renewedToken;
      resealed = seal(secrets, uid);
    }

    res.json({
      success: true,
      steamId: session.steamId,
      sealed: resealed,
      tokenExpires: tokenExpiry(secrets.refreshToken)
    });
  }));

  app.post("/api/steam/disconnect", handle(async (req, res) => {
    const session = getSession(res.locals.uid, requireSteamId(req.body.steamId));
    if (session) disconnectSession(session);
    res.json({ success: true });
  }));

  // Which accounts currently have a live session on the server (active / stale status in the UI)
  app.post("/api/steam/sessions", handle(async (req, res) => {
    res.json({ sessions: listSessions(res.locals.uid) });
  }));

  app.post("/api/steam/automation", handle(async (req, res) => {
    const session = requireSession(res.locals.uid, requireSteamId(req.body.steamId));
    session.automation = !!req.body.enabled;
    res.json({ success: true, automation: session.automation });
  }));

  app.post("/api/steam/wallet", handle(async (req, res) => {
    const session = getSession(res.locals.uid, requireSteamId(req.body.steamId));
    if (!session || !session.loggedIn) {
      return res.json({ balance: "0.00", currency: "USD", loggedIn: false });
    }
    res.json(await fetchSteamWallet(session));
  }));

  app.post("/api/steam/code", handle(async (req, res) => {
    const secrets = unseal(req.body.sealed, res.locals.uid);
    if (!secrets.sharedSecret) throw new HttpError(400, "No shared_secret for this account");
    res.json({ code: SteamTotp.getAuthCode(secrets.sharedSecret), validFor: 30 - (SteamTotp.time() % 30) });
  }));

  app.post("/api/steam/profile", handle(async (req, res) => {
    const steamId = requireSteamId(req.body.steamId);
    const proxy = normalizeProxy(req.body.proxy);
    res.json(await fetchProfile(steamId, getSession(res.locals.uid, steamId), proxy));
  }));

  // ---------------------------------------------------------------- inventory & prices

  app.post("/api/steam/inventory", rateLimit(30, 60_000), handle(async (req, res) => {
    const steamId = requireSteamId(req.body.steamId);
    const appId = Number(req.body.appId) || 730;
    const contextId = Number(req.body.contextId) || (appId === 753 ? 6 : 2);
    const proxy = normalizeProxy(req.body.proxy);

    const session = getSession(res.locals.uid, steamId);
    console.log(`[Steam] Inventory ${steamId} app ${appId}/${contextId}${session?.loggedIn ? " (session)" : " (anonymous)"}`);
    res.json({ inventory: await fetchSteamInventory(session, steamId, appId, contextId, proxy) });
  }));

  app.post("/api/prices", rateLimit(60, 60_000), handle(async (req, res) => {
    const raw = Array.isArray(req.body.items) ? req.body.items : [];
    if (raw.length > 1000) throw new HttpError(400, "Too many items (max 1000)");
    const items = raw
      .map((i: any) => ({ appId: Number(i.appId) || 730, name: String(i.name || "").slice(0, 200) }))
      .filter((i: any) => i.name);
    res.json(await getPrices(items));
  }));

  // ---------------------------------------------------------------- automation & trades

  app.post("/api/steam/confirmations", handle(async (req, res) => {
    const session = requireSession(res.locals.uid, requireSteamId(req.body.steamId));
    const confs = await listConfirmations(session);
    res.json({
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
    });
  }));

  app.post("/api/steam/confirmations/respond", rateLimit(30, 60_000), handle(async (req, res) => {
    const session = requireSession(res.locals.uid, requireSteamId(req.body.steamId));
    const ids = requireIdList(req.body.ids, 200);
    res.json(await respondToConfirmations(session, ids, req.body.accept !== false));
  }));

  // One-shot run of what the automation toggle does in the background
  app.post("/api/steam/confirmations/auto", rateLimit(30, 60_000), handle(async (req, res) => {
    const session = requireSession(res.locals.uid, requireSteamId(req.body.steamId));
    res.json(await confirmAutomatic(session));
  }));

  app.post("/api/steam/offers/accept-safe", rateLimit(30, 60_000), handle(async (req, res) => {
    const session = requireSession(res.locals.uid, requireSteamId(req.body.steamId));
    res.json(await acceptSafeOffers(session));
  }));

  app.post("/api/steam/transfer", rateLimit(30, 60_000), handle(async (req, res) => {
    const uid = res.locals.uid as string;
    const from = requireSession(uid, requireSteamId(req.body.fromSteamId));
    const to = requireSession(uid, requireSteamId(req.body.toSteamId));
    const appId = Number(req.body.appId) || 730;
    const contextId = Number(req.body.contextId) || (appId === 753 ? 6 : 2);
    const assetIds = requireIdList(req.body.assetIds, 500);
    res.json(await transferItems(from, to, appId, contextId, assetIds));
  }));

  // ---------------------------------------------------------------- games

  app.post("/api/games/free", handle(async (req, res) => {
    res.json({ games: await findFreePromotions() });
  }));

  app.post("/api/games/add", rateLimit(30, 60_000), handle(async (req, res) => {
    const session = requireSession(res.locals.uid, requireSteamId(req.body.steamId));
    const appIds = requireIdList(req.body.appIds, 50).map(Number);
    if (appIds.length === 0) throw new HttpError(400, "No appIds");
    res.json(await addFreeLicenses(session, appIds));
  }));

  // ---------------------------------------------------------------- misc

  app.post("/api/events", handle(async (req, res) => {
    res.json({ events: getEvents(res.locals.uid, Number(req.body.since) || 0) });
  }));

  app.post("/api/proxy/test", rateLimit(20, 60_000), handle(async (req, res) => {
    const proxy = normalizeProxy(req.body.proxy);
    if (!proxy) throw new HttpError(400, "No proxy provided");

    try {
      const response = await axios.get("https://api.ipify.org?format=json", {
        httpsAgent: getProxyAgent(proxy),
        proxy: false, // Critical for custom agents in Axios
        timeout: 20000
      });
      res.json({ success: true, status: response.status, ip: response.data.ip });
    } catch (error: any) {
      let errorMsg = error.message;
      if (error.code === "ECONNRESET") errorMsg = "Connection Reset: The proxy closed the connection. Check your credentials or protocol (SOCKS vs HTTP).";
      if (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED") errorMsg = "Connection Timeout: The proxy is too slow or unresponsive.";
      res.status(502).json({
        error: errorMsg,
        code: error.code,
        details: error.response?.status ? `HTTP ${error.response.status}` : "Handshake failed"
      });
    }
  }));

  // Unknown API routes must not fall through to the SPA
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Local only by default; set HOST=0.0.0.0 explicitly to expose it on the network
  const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  app.listen(PORT, HOST, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
