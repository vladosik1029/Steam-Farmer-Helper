import { setDoc } from './store';
import { apiPost } from './api';
import { addLog } from './logs';
import type { SteamAccount } from './types';

export async function updateAccount(account: SteamAccount, data: Record<string, unknown>, unset: string[] = []) {
  await setDoc('accounts', account.id, { ...data, lastCheck: new Date().toISOString() }, { merge: true, unset });
}

type SealResult = { sealed: string; steamId?: string; hasToken: boolean; tokenExpires: number | null };

// Stores the result of accounts/seal and wipes legacy plaintext fields
export async function saveSealedSecrets(account: SteamAccount, result: SealResult) {
  const update: Record<string, unknown> = {
    secrets: result.sealed,
    hasToken: result.hasToken,
    tokenExpires: result.tokenExpires ?? null
  };
  if (result.steamId) update.steamId = result.steamId;
  await updateAccount(account, update, ['password', 'maFileData']);
  return result.sealed;
}

// Accounts imported from old web versions may keep password + maFile secrets in plain text: encrypt them
// (logging in once with the old password to get a refresh token) and delete the plaintext.
export async function ensureSealed(account: SteamAccount, onStatus?: (status: string) => void): Promise<string> {
  if (account.secrets) return account.secrets;
  if (!account.maFileData?.shared_secret && !account.password) {
    throw new Error('No Steam secrets stored. Re-import the maFile.');
  }

  onStatus?.('Шифрую секреты...');
  const result = await apiPost<SealResult>('/api/accounts/seal', {
    accountName: account.accountName,
    password: account.password || undefined,
    sharedSecret: account.maFileData?.shared_secret,
    identitySecret: account.maFileData?.identity_secret,
    revocationCode: account.maFileData?.revocation_code,
    proxy: account.proxy
  });
  return saveSealedSecrets(account, result);
}

// Pulls name, avatar and bans; bans are complete only while the account is connected
export async function refreshProfile(account: SteamAccount, steamId = account.steamId) {
  if (!steamId) return;
  const profile = await apiPost('/api/steam/profile', { steamId, proxy: account.proxy }).catch(() => null);
  if (!profile?.personaName) return;

  const update: Record<string, unknown> = {
    personaName: profile.personaName,
    avatar: profile.avatar || '',
    vacBanned: !!profile.vacBanned,
    tradeBanState: profile.tradeBanState || 'None',
    isLimitedAccount: !!profile.isLimitedAccount
  };
  for (const key of ['vacBans', 'gameBans', 'daysSinceLastBan', 'communityBanned'] as const) {
    if (profile[key] !== undefined) update[key] = profile[key];
  }
  await updateAccount(account, update);
}

// Starts a Steam session from the stored refresh token, then stores
// the real SteamID64, wallet and public profile.
export async function loginSteamAccount(account: SteamAccount, onStatus?: (status: string) => void) {
  const sealed = await ensureSealed(account, onStatus);

  onStatus?.('Подключение...');
  let data: any;
  try {
    data = await apiPost('/api/steam/connect', {
      accountName: account.accountName,
      sealed,
      steamId: account.steamId,
      proxy: account.proxy,
      automation: !!account.automation
    });
  } catch (err: any) {
    await addLog({ level: 'error', type: 'login', message: `Вход не удался: ${err.message}`, accountName: account.accountName, steamId: account.steamId });
    throw err;
  }

  // Steam returns the real SteamID64; fix accounts imported with a corrupted ID
  const realSteamId = String(data.steamId);
  const update: Record<string, unknown> = { status: 'active' };
  if (realSteamId !== account.steamId) update.steamId = realSteamId;
  if (data.sealed) {
    // steam-user renewed the refresh token
    update.secrets = data.sealed;
    update.tokenExpires = data.tokenExpires ?? null;
  }
  await updateAccount(account, update);

  onStatus?.('Кошелёк...');
  const walletData = await apiPost('/api/steam/wallet', { steamId: realSteamId }).catch(() => null);
  if (walletData?.loggedIn && !walletData.error) {
    await updateAccount(account, {
      walletBalance: walletData.balance,
      walletCurrency: walletData.currency
    });
  }

  onStatus?.('Профиль...');
  await refreshProfile(account, realSteamId);
  await addLog({ level: 'success', type: 'login', message: 'Сессия Steam подключена', accountName: account.accountName, steamId: realSteamId });
  return realSteamId;
}

export async function setAutomation(account: SteamAccount, enabled: boolean, connected: boolean) {
  await updateAccount(account, { automation: enabled });
  if (connected && account.steamId) {
    await apiPost('/api/steam/automation', { steamId: account.steamId, enabled });
  }
  await addLog({
    level: 'info',
    type: 'automation',
    message: enabled ? 'Автоподтверждение включено' : 'Автоподтверждение выключено',
    accountName: account.accountName,
    steamId: account.steamId
  });
}
