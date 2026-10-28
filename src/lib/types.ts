export type { GuardAccount, GuardConfirmation, ConfirmationKind } from '../../electron/core/guard';
export type { TradeOfferView } from '../../electron/core/trades';

export interface TradePartner {
  id: string;
  label: string;
  link: string;
  steamId: string;
  personaName?: string;
  avatar?: string;
  createdAt: number;
}

export interface SteamAccount {
  id: string;
  accountName: string;
  steamId?: string;
  personaName?: string;
  avatar?: string;
  walletBalance?: string;
  walletCurrency?: string;
  vacBanned?: boolean;
  vacBans?: number;
  gameBans?: number;
  daysSinceLastBan?: number;
  tradeBanState?: string;
  isLimitedAccount?: boolean;
  communityBanned?: boolean;
  status: 'active' | 'stale' | 'error';
  proxy?: string;
  // Background auto-confirmation of market listings and safe incoming trades
  automation?: boolean;
  // Server-encrypted blob with shared/identity secret and the Steam refresh token
  secrets?: string;
  hasToken?: boolean;
  tokenExpires?: number | null;
  lastCheck?: string;
  // Legacy plaintext fields, removed on migration
  password?: string;
  maFileData?: {
    shared_secret: string;
    identity_secret: string;
    revocation_code: string;
  };
}

export interface ProxyConfig {
  id: string;
  url: string; // http://user:pass@ip:port
  label: string;
  status: 'active' | 'dead';
  lastUsed?: any;
}

export interface SessionInfo {
  steamId: string;
  accountName: string;
  loggedIn: boolean;
  automation: boolean;
  connectedAt: number;
  lastError: string | null;
  canConfirm: boolean;
}

export interface InventoryItem {
  id: string;
  assetid: string;
  appid: number;
  contextid: string;
  classid: string;
  instanceid: string;
  amount?: number;
  name: string;
  market_hash_name: string;
  market_name?: string;
  icon_url: string;
  name_color?: string;
  type: string;
  tradable: boolean;
  marketable: boolean;
  tags?: { category: string; internal_name: string; localized_tag_name?: string; name?: string; color?: string }[];
}

export interface LogEntry {
  id: string;
  ownerUid: string;
  time: number;
  level: 'info' | 'success' | 'warning' | 'error';
  type: string;
  message: string;
  accountName?: string;
  steamId?: string;
  source: 'client' | 'server';
}

// Session status shown on account cards
export type SessionState = 'active' | 'stale' | 'token-expired' | 'no-token' | 'unsealed';

export function sessionState(account: SteamAccount, session?: SessionInfo): SessionState {
  if (!account.secrets) return 'unsealed';
  if (!account.hasToken) return 'no-token';
  if (account.tokenExpires && account.tokenExpires < Date.now()) return 'token-expired';
  return session?.loggedIn ? 'active' : 'stale';
}
