import crypto from "crypto";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Secrets encryption
// Steam secrets (shared/identity secret, refresh token) are stored on disk
// only as an AES-256-GCM blob. The key itself is protected by the Windows
// account (Electron safeStorage, see electron/keystore.ts).
// ---------------------------------------------------------------------------

let SECRETS_KEY: Buffer | null = null;

export function setSecretsKey(key: Buffer) {
  if (key.length !== 32) throw new Error("Secrets key must be 32 bytes.");
  SECRETS_KEY = key;
}

function secretsKey(): Buffer {
  if (!SECRETS_KEY) throw new HttpError(500, "Secrets key is not loaded yet.");
  return SECRETS_KEY;
}

export type AccountSecrets = {
  sharedSecret?: string;
  identitySecret?: string;
  revocationCode?: string;
  refreshToken?: string;
};

// The owner's uid is used as AAD, so a blob copied into another profile won't decrypt.
// `key` is only passed when importing blobs sealed by the old web version.
export function seal(secrets: AccountSecrets, uid: string, key = secretsKey()): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(uid));
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
}

export function unseal(sealed: string, uid: string, key = secretsKey()): AccountSecrets {
  if (typeof sealed !== "string" || !sealed.startsWith("v1.")) {
    throw new HttpError(400, "Invalid secrets blob");
  }
  try {
    const raw = Buffer.from(sealed.slice(3), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(uid));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
  } catch {
    throw new HttpError(400, "Cannot decrypt account secrets (wrong key or foreign blob).");
  }
}

// Refresh tokens are JWTs; `exp` tells the UI when the user has to enter the password again
export function tokenExpiry(refreshToken?: string): number | null {
  if (!refreshToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(refreshToken.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export const STEAM_ID_RE = /^7656\d{13}$/;

export function requireSteamId(value: unknown): string {
  const id = String(value || "");
  if (!STEAM_ID_RE.test(id)) throw new HttpError(400, "Invalid SteamID64");
  return id;
}

export function requireAccountName(value: unknown): string {
  const name = String(value || "").trim();
  if (!name || name.length > 64) throw new HttpError(400, "Invalid account name");
  return name;
}

export function requireIdList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map(String).filter((v) => /^\d{1,20}$/.test(v));
  if (ids.length > max) throw new HttpError(400, `Too many ids (max ${max})`);
  return ids;
}
