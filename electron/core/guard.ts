import { HttpError } from "./security.ts";
import { logEvent } from "./events.ts";
import { allSessions, getOffer, listConfirmations, respondToConfirmation, type SteamSession } from "./steam.ts";

// ---------------------------------------------------------------------------
// Steam Guard: one feed of mobile confirmations for every connected account.
// Polled in the background, so new confirmations show up (and notify) while
// the window is closed to the tray. Automation approves market listings and
// trades this app created; everything else waits for the user.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000;
// Spread requests out so many accounts don't hit Steam's rate limit at once
const ACCOUNT_GAP_MS = 1_500;

const TYPE_TRADE = 2;
const TYPE_MARKET = 3;
const TYPE_PHONE = 5;
const TYPE_RECOVERY = 6;
const TYPE_API_KEY = 9;

export type ConfirmationKind = "trade" | "market" | "api-key" | "phone" | "recovery" | "other";

export type GuardConfirmation = {
  id: string;
  type: number;
  kind: ConfirmationKind;
  title: string;
  sending: string;
  receiving: string;
  time: number;
  icon: string;
  offerId?: string;
  partnerSteamId?: string;
  partnerIsOwn?: boolean;
  give?: number;
  receive?: number;
  ours: boolean;
  // Set when the confirmation must be checked and approved one by one
  danger: string | null;
};

export type GuardAccount = {
  steamId: string;
  accountName: string;
  confirmations: GuardConfirmation[];
  fetchedAt: number | null;
  error: string | null;
};

type GuardHooks = {
  isOwnAccount: (steamId: string) => boolean;
  onChange: () => void;
  onNew: (account: GuardAccount, added: GuardConfirmation[]) => void;
};

let hooks: GuardHooks = { isOwnAccount: () => false, onChange: () => {}, onNew: () => {} };

export function configureGuard(value: GuardHooks) {
  hooks = value;
}

const feed = new Map<string, GuardAccount>();
const seen = new Map<string, Set<string>>();
// Offer details don't change; keep them so every poll doesn't refetch them
const offerCache = new Map<string, { partner: string; give: number; receive: number }>();

const canPoll = (s: SteamSession) => s.loggedIn && !!s.identitySecret && !!s.steamId;

export function kindOf(type: number, title: string): ConfirmationKind {
  if (type === TYPE_TRADE) return "trade";
  if (type === TYPE_MARKET) return "market";
  if (type === TYPE_API_KEY || /api key|ключ.*api|api.*ключ/i.test(title)) return "api-key";
  if (type === TYPE_PHONE) return "phone";
  if (type === TYPE_RECOVERY) return "recovery";
  return "other";
}

async function offerDetails(session: SteamSession, offerId: string) {
  const cached = offerCache.get(offerId);
  if (cached) return cached;
  const offer = await getOffer(session, offerId);
  const details = {
    partner: offer.partner.getSteamID64(),
    give: offer.itemsToGive.length,
    receive: offer.itemsToReceive.length
  };
  if (offerCache.size > 1000) offerCache.clear();
  offerCache.set(offerId, details);
  return details;
}

// Why a confirmation must not be approved in bulk, or null when it is routine
export function assessDanger(item: GuardConfirmation, intendedPartner?: string): string | null {
  switch (item.kind) {
    case "api-key":
      return "Создание Web API ключа. Так часто крадут предметы: подтверждайте, только если создавали ключ сами.";
    case "phone":
      return "Смена номера телефона на аккаунте.";
    case "recovery":
      return "Восстановление аккаунта.";
    case "other":
      return "Нестандартное подтверждение. Проверьте, что это вы его запросили.";
    case "trade":
      if (intendedPartner && item.partnerSteamId && intendedPartner !== item.partnerSteamId) {
        return "Партнёр не совпадает с тем, кому приложение создавало обмен. Возможна подмена обмена.";
      }
      if ((item.give ?? 0) > 0 && item.receive === 0 && !item.partnerIsOwn) {
        return "Вы только отдаёте предметы чужому аккаунту.";
      }
      return null;
    default:
      return null;
  }
}

async function describe(session: SteamSession, conf: any): Promise<GuardConfirmation> {
  const kind = kindOf(Number(conf.type), String(conf.title || ""));
  const offerId = kind === "trade" && conf.creator ? String(conf.creator) : undefined;
  const intendedPartner = offerId ? session.ourOffers.get(offerId) : undefined;
  const item: GuardConfirmation = {
    id: String(conf.id),
    type: Number(conf.type),
    kind,
    title: String(conf.title || ""),
    sending: String(conf.sending || ""),
    receiving: String(conf.receiving || ""),
    time: new Date(conf.timestamp || conf.time || Date.now()).getTime(),
    icon: String(conf.icon || ""),
    offerId,
    ours: !!intendedPartner,
    danger: null
  };

  if (offerId) {
    try {
      const details = await offerDetails(session, offerId);
      item.partnerSteamId = details.partner;
      item.partnerIsOwn = hooks.isOwnAccount(details.partner);
      item.give = details.give;
      item.receive = details.receive;
    } catch {
      // Without details the summary from Steam (sending/receiving) is still shown
    }
  }

  item.danger = assessDanger(item, intendedPartner);
  return item;
}

// Approves what automation is allowed to: market listings and safe trades this app created
async function autoConfirm(session: SteamSession, confs: any[], items: GuardConfirmation[]) {
  const done = new Set<string>();
  for (const item of items) {
    const allowed = !item.danger && (item.kind === "market" || (item.kind === "trade" && item.ours));
    if (!allowed) continue;
    const conf = confs.find((c) => String(c.id) === item.id);
    try {
      await respondToConfirmation(session, conf, true);
      done.add(item.id);
      logEvent(session.uid, {
        level: "success",
        steamId: session.steamId,
        accountName: session.accountName,
        type: item.kind === "market" ? "market-confirm" : "trade-confirm",
        message: `Подтверждено автоматически: ${item.title}`
      });
    } catch (err: any) {
      logEvent(session.uid, {
        level: "error",
        steamId: session.steamId,
        accountName: session.accountName,
        type: "confirm-error",
        message: `${item.title}: ${err.message}`
      });
    }
  }
  return done;
}

// Fetches one account's confirmations. `auto` runs the automation rules
// even when the account's automation toggle is off (manual "confirm market" button).
export async function pollAccount(session: SteamSession, auto = session.automation) {
  const entry: GuardAccount = feed.get(session.steamId) || {
    steamId: session.steamId,
    accountName: session.accountName,
    confirmations: [],
    fetchedAt: null,
    error: null
  };
  let accepted = 0;
  try {
    const confs = await listConfirmations(session);
    let items = await Promise.all(confs.map((c) => describe(session, c)));
    if (auto) {
      const done = await autoConfirm(session, confs, items);
      accepted = done.size;
      items = items.filter((i) => !done.has(i.id));
    }
    entry.confirmations = items.sort((a, b) => b.time - a.time);
    entry.fetchedAt = Date.now();
    entry.error = null;
  } catch (err: any) {
    entry.error = err.message;
  }
  feed.set(session.steamId, entry);

  const known = seen.get(session.steamId) || new Set<string>();
  const added = entry.confirmations.filter((c) => !known.has(c.id));
  seen.set(session.steamId, new Set(entry.confirmations.map((c) => c.id)));
  if (added.length > 0) hooks.onNew(entry, added);
  hooks.onChange();
  return { total: entry.confirmations.length + accepted, accepted };
}

export function guardState(): GuardAccount[] {
  // Accounts that disconnected or lost identity_secret drop out of the feed
  const live = new Set(allSessions().filter(canPoll).map((s) => s.steamId));
  for (const steamId of feed.keys()) {
    if (!live.has(steamId)) {
      feed.delete(steamId);
      seen.delete(steamId);
    }
  }
  return [...feed.values()];
}

export const pendingCount = () => guardState().reduce((sum, a) => sum + a.confirmations.length, 0);

export async function respondGuard(session: SteamSession, ids: string[], accept: boolean, confirmDanger: boolean) {
  if (ids.length === 0) throw new HttpError(400, "Ничего не выбрано.");
  const known = feed.get(session.steamId)?.confirmations || [];
  const dangerous = known.filter((c) => ids.includes(c.id) && c.danger);
  if (accept && dangerous.length > 0 && (!confirmDanger || ids.length > 1)) {
    throw new HttpError(400, "Опасные подтверждения можно принять только по одному, после проверки.", "DANGER");
  }

  const confs = await listConfirmations(session);
  let done = 0;
  for (const conf of confs.filter((c) => ids.includes(String(c.id)))) {
    await respondToConfirmation(session, conf, accept);
    done++;
    logEvent(session.uid, {
      level: accept ? "success" : "warning",
      steamId: session.steamId,
      accountName: session.accountName,
      type: accept ? "confirm" : "confirm-cancel",
      message: `${accept ? "Подтверждено" : "Отклонено"}: ${conf.title}`
    });
  }
  await pollAccount(session, false);
  return { done };
}

// ---------------------------------------------------------------- background poll

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollAll() {
  for (const session of allSessions().filter(canPoll)) {
    await pollAccount(session).catch((err) => console.error("[Guard]", err.message));
    await sleep(ACCOUNT_GAP_MS);
  }
  guardState();
  hooks.onChange();
}

async function loop() {
  const started = Date.now();
  await pollAll().catch((err) => console.error("[Guard]", err.message));
  setTimeout(loop, Math.max(5_000, POLL_INTERVAL_MS - (Date.now() - started)));
}

export function startGuard() {
  setTimeout(loop, 5_000);
}
