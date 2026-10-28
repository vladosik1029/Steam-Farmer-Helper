import SteamTotp from "steam-totp";

// Guard codes and confirmation keys depend on the clock. A PC clock that is
// off by 30+ seconds gives wrong codes, so everything uses Steam's time.

let offset = 0;
let syncedAt = 0;
const RESYNC_MS = 60 * 60 * 1000;

export async function syncSteamTime() {
  try {
    offset = await new Promise<number>((resolve, reject) =>
      SteamTotp.getTimeOffset((err: any, value: number) => (err ? reject(err) : resolve(value)))
    );
    syncedAt = Date.now();
  } catch (err: any) {
    console.warn("[Time] Steam time sync failed:", err.message);
  }
}

export const steamTime = () => SteamTotp.time(offset);
export const timeOffset = () => ({ offset, syncedAt });

export function authCode(sharedSecret: string) {
  return { code: SteamTotp.getAuthCode(sharedSecret, offset), validFor: 30 - (steamTime() % 30) };
}

export function confirmationKey(identitySecret: string, tag: "conf" | "allow" | "cancel" | "details") {
  const time = steamTime();
  return { time, key: SteamTotp.getConfirmationKey(identitySecret, time, tag) };
}

syncSteamTime();
setInterval(() => {
  if (Date.now() - syncedAt > RESYNC_MS) syncSteamTime();
}, 10 * 60 * 1000).unref();
