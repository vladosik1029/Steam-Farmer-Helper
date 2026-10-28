import axios from "axios";

// Prices are in RUB: market.csgo publishes its RUB price list, Steam is asked with currency=5.

const STEAM_CURRENCY_RUB = 5;
const CSGO_TTL_MS = 15 * 60_000;
const STEAM_TTL_MS = 6 * 60 * 60_000;
// priceoverview allows roughly 20 requests per minute per IP
const STEAM_REQUEST_GAP_MS = 3500;
const STEAM_BACKOFF_MS = 60_000;

// ---------------------------------------------------------------------------
// market.csgo: one request returns the whole CS2 price list
// ---------------------------------------------------------------------------

let csgoPrices = new Map<string, number>();
let csgoFetchedAt = 0;
let csgoLoading: Promise<void> | null = null;

async function refreshCsgoPrices() {
  const response = await axios.get("https://market.csgo.com/api/v2/prices/RUB.json", { timeout: 60000 });
  const next = new Map<string, number>();
  for (const item of response.data?.items || []) {
    const price = Number(item.price);
    if (item.market_hash_name && price > 0) next.set(item.market_hash_name, price);
  }
  csgoPrices = next;
  csgoFetchedAt = Date.now();
  console.log(`[Prices] market.csgo: ${next.size} items`);
}

async function ensureCsgoPrices() {
  if (Date.now() - csgoFetchedAt < CSGO_TTL_MS && csgoPrices.size > 0) return;
  if (!csgoLoading) {
    csgoLoading = refreshCsgoPrices()
      .catch((err) => console.error("[Prices] market.csgo failed:", err.message))
      .finally(() => { csgoLoading = null; });
  }
  await csgoLoading;
}

// ---------------------------------------------------------------------------
// Steam Market: per-item priceoverview, cached and fetched by a slow background queue
// ---------------------------------------------------------------------------

type SteamPrice = { lowest: number | null; median: number | null; volume: number; at: number };
const steamPrices = new Map<string, SteamPrice>();
const steamQueue: { appId: number; name: string }[] = [];
const queued = new Set<string>();
let queueRunning = false;
let backoffUntil = 0;

const steamKey = (appId: number, name: string) => `${appId}:${name}`;

// "1 234,56 руб." -> 1234.56
function parseRub(value?: string): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^\d,.]/g, "").replace(",", ".");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

async function fetchSteamPrice(appId: number, name: string) {
  const response = await axios.get("https://steamcommunity.com/market/priceoverview/", {
    params: { appid: appId, currency: STEAM_CURRENCY_RUB, market_hash_name: name },
    timeout: 15000,
    validateStatus: () => true
  });
  if (response.status === 429) {
    backoffUntil = Date.now() + STEAM_BACKOFF_MS;
    console.warn(`[Prices] Steam priceoverview rate limited, pausing ${STEAM_BACKOFF_MS / 1000}s`);
    throw new Error("rate limited");
  }
  const data = response.data || {};
  steamPrices.set(steamKey(appId, name), {
    lowest: parseRub(data.lowest_price),
    median: parseRub(data.median_price),
    volume: Number(String(data.volume || "0").replace(/\D/g, "")) || 0,
    at: Date.now()
  });
}

async function runSteamQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (steamQueue.length > 0) {
      const wait = Math.max(0, backoffUntil - Date.now());
      await new Promise((r) => setTimeout(r, wait + STEAM_REQUEST_GAP_MS));
      const next = steamQueue[0];
      try {
        await fetchSteamPrice(next.appId, next.name);
        steamQueue.shift();
        queued.delete(steamKey(next.appId, next.name));
      } catch (err: any) {
        if (err.message !== "rate limited") {
          // Unknown/unmarketable item: remember "no price" so it isn't retried every time
          steamPrices.set(steamKey(next.appId, next.name), { lowest: null, median: null, volume: 0, at: Date.now() });
          steamQueue.shift();
          queued.delete(steamKey(next.appId, next.name));
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

export async function getPrices(items: { appId: number; name: string }[]) {
  const needsCsgo = items.some((i) => i.appId === 730);
  if (needsCsgo) await ensureCsgoPrices();

  const steam: Record<string, SteamPrice | null> = {};
  const csgo: Record<string, number | null> = {};
  let pending = 0;

  for (const { appId, name } of items) {
    const key = steamKey(appId, name);
    const cached = steamPrices.get(key);
    if (cached && Date.now() - cached.at < STEAM_TTL_MS) {
      steam[name] = cached;
    } else {
      steam[name] = cached || null;
      pending++;
      if (!queued.has(key)) {
        queued.add(key);
        steamQueue.push({ appId, name });
      }
    }
    if (appId === 730) csgo[name] = csgoPrices.get(name) ?? null;
  }

  runSteamQueue().catch(() => {});
  return {
    steam,
    csgo,
    pending,
    queueLength: steamQueue.length,
    rateLimitedUntil: backoffUntil > Date.now() ? backoffUntil : null,
    csgoUpdatedAt: csgoFetchedAt || null
  };
}
