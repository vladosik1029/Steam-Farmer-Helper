import "./env.ts";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import type express from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ROOT_DIR } from "./paths.ts";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Secrets encryption
// Steam secrets (shared/identity secret, refresh token) are stored in Firestore
// only as an AES-256-GCM blob. The key never leaves the server.
// ---------------------------------------------------------------------------

function loadSecretsKey(): Buffer {
  let hex = process.env.SECRETS_KEY;
  if (!hex) {
    hex = crypto.randomBytes(32).toString("hex");
    const envFile = path.join(ROOT_DIR, ".env.local");
    fs.appendFileSync(envFile, `\n# Encryption key for Steam secrets. Losing it means re-entering all Steam passwords.\nSECRETS_KEY="${hex}"\n`);
    console.warn(`[Security] SECRETS_KEY was missing, generated a new one in ${envFile}. Back it up!`);
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("SECRETS_KEY must be 64 hex characters (32 bytes).");
  return key;
}

const SECRETS_KEY = loadSecretsKey();

export type AccountSecrets = {
  sharedSecret?: string;
  identitySecret?: string;
  revocationCode?: string;
  refreshToken?: string;
};

// The owner's uid is used as AAD, so a blob copied into another user's account won't decrypt
export function seal(secrets: AccountSecrets, uid: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SECRETS_KEY, iv);
  cipher.setAAD(Buffer.from(uid));
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
}

export function unseal(sealed: string, uid: string): AccountSecrets {
  if (typeof sealed !== "string" || !sealed.startsWith("v1.")) {
    throw new HttpError(400, "Invalid secrets blob");
  }
  try {
    const raw = Buffer.from(sealed.slice(3), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", SECRETS_KEY, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(uid));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
  } catch {
    throw new HttpError(400, "Cannot decrypt account secrets (wrong SECRETS_KEY or foreign blob).");
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
// Auth: every /api route except health requires a Firebase ID token
// ---------------------------------------------------------------------------

const firebaseConfigFile = path.join(ROOT_DIR, "firebase-applet-config.json");
if (!fs.existsSync(firebaseConfigFile)) {
  throw new Error("firebase-applet-config.json is missing. Copy firebase-applet-config.example.json and fill in your Firebase project.");
}
const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigFile, "utf8"));
const FIREBASE_PROJECT_ID: string = firebaseConfig.projectId;
const firebaseJwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
);

export async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const { payload } = await jwtVerify(token, firebaseJwks, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID
    });
    if (!payload.sub) throw new Error("No subject");
    res.locals.uid = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session, please sign in again" });
  }
}

// Simple fixed-window limiter, keyed by uid + route
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(max: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${res.locals.uid}:${req.path}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (++bucket.count > max) {
      return res.status(429).json({ error: "Too many requests, slow down." });
    }
    next();
  };
}

// Wraps async handlers so thrown HttpErrors become JSON responses instead of hanging requests
export const handle = (fn: (req: express.Request, res: express.Response) => Promise<any>) =>
  (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err: any) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(`[API] ${req.path}:`, err.message);
      if (!res.headersSent) res.status(status).json({ error: err.message, code: err.code });
    });
  };

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
