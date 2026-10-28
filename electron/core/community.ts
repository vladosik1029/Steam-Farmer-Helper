import { HttpError } from "./security.ts";

// ---------------------------------------------------------------------------
// steamcommunity.com limits requests per IP, and one 429 blocks every page
// for that IP for a while: confirmations, inventories, trades and market
// prices alike. So every request to it goes through one queue per IP
// (direct connection or a proxy): spaced out, user actions and confirmations
// first, background price lookups only when nothing else is waiting, and a
// shared pause after a 429 instead of hammering Steam further.
// ---------------------------------------------------------------------------

export type Priority = "high" | "low";

const HIGH_GAP_MS = 1_200;
const LOW_GAP_MS = 6_000;
const BACKOFF_STEPS_MS = [60_000, 120_000, 300_000, 600_000];

type Task = { priority: Priority; run: () => Promise<void>; fail: (err: Error) => void };

type Gate = {
  queue: Task[];
  running: boolean;
  lastAt: number;
  lastLowAt: number;
  cooldownUntil: number;
  strikes: number;
};

const gates = new Map<string, Gate>();

const gateKey = (proxy?: string) => proxy || "direct";

function gateFor(proxy?: string): Gate {
  const key = gateKey(proxy);
  let gate = gates.get(key);
  if (!gate) {
    gate = { queue: [], running: false, lastAt: 0, lastLowAt: 0, cooldownUntil: 0, strikes: 0 };
    gates.set(key, gate);
  }
  return gate;
}

export function isRateLimit(err: any) {
  return err?.status === 429 || err?.response?.status === 429 || /\b429\b|too many requests|rate limit/i.test(String(err?.message || ""));
}

// When Steam lets this IP in again, or null if it isn't paused
export function cooldownUntil(proxy?: string): number | null {
  const until = gates.get(gateKey(proxy))?.cooldownUntil || 0;
  return until > Date.now() ? until : null;
}

export function rateLimitError(until: number) {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  const wait = seconds >= 90 ? `${Math.ceil(seconds / 60)} мин` : `${seconds} с`;
  return new HttpError(429, `Steam временно ограничил запросы с этого IP (429). Повторите через ${wait}. Помогают прокси на аккаунтах.`, "RATE_LIMITED");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function drain(gate: Gate) {
  if (gate.running) return;
  gate.running = true;
  try {
    // Let calls made in the same tick join the queue, so priorities apply to them
    await sleep(0);
    while (gate.queue.length > 0) {
      // During a pause, user actions fail at once instead of hanging for minutes
      if (gate.cooldownUntil > Date.now()) {
        for (const t of gate.queue.filter((t) => t.priority === "high")) t.fail(rateLimitError(gate.cooldownUntil));
        gate.queue = gate.queue.filter((t) => t.priority !== "high");
        if (gate.queue.length === 0) break;
      }
      // High priority first; a low task waits for its own, longer gap
      const index = gate.queue.findIndex((t) => t.priority === "high");
      const task = gate.queue[index >= 0 ? index : 0];
      const gap = task.priority === "high" ? HIGH_GAP_MS : LOW_GAP_MS;
      const since = task.priority === "high" ? gate.lastAt : Math.max(gate.lastAt, gate.lastLowAt);
      const wait = Math.max(gate.cooldownUntil - Date.now(), since + gap - Date.now(), 0);
      if (wait > 0) {
        await sleep(Math.min(wait, 1_000));
        continue; // re-check: a high-priority task may have arrived meanwhile
      }
      gate.queue.splice(gate.queue.indexOf(task), 1);
      gate.lastAt = Date.now();
      if (task.priority === "low") gate.lastLowAt = gate.lastAt;
      await task.run();
    }
  } finally {
    gate.running = false;
  }
}

// Runs one request to steamcommunity.com through the queue of its IP.
// High-priority calls fail at once during a pause (the user sees why);
// low-priority ones simply wait it out.
export function community<T>(proxy: string | undefined, fn: () => Promise<T>, priority: Priority = "high"): Promise<T> {
  const gate = gateFor(proxy);
  if (priority === "high" && gate.cooldownUntil > Date.now()) {
    return Promise.reject(rateLimitError(gate.cooldownUntil));
  }
  return new Promise<T>((resolve, reject) => {
    gate.queue.push({
      priority,
      fail: reject,
      run: async () => {
        try {
          const result = await fn();
          gate.strikes = 0;
          resolve(result);
        } catch (err: any) {
          if (isRateLimit(err)) {
            const step = BACKOFF_STEPS_MS[Math.min(gate.strikes, BACKOFF_STEPS_MS.length - 1)];
            gate.strikes++;
            gate.cooldownUntil = Date.now() + step;
            console.warn(`[Steam] 429 from steamcommunity.com (${gateKey(proxy) === "direct" ? "direct" : "proxy"}), pausing ${step / 1000}s`);
            reject(rateLimitError(gate.cooldownUntil));
          } else {
            reject(err);
          }
        }
      }
    });
    drain(gate).catch(() => {});
  });
}
