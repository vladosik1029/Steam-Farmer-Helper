import fs from "fs";
import path from "path";
import crypto from "crypto";
import { safeStorage } from "electron";

const KEY_FILE = "secrets.key";

// The key that encrypts Steam secrets. On disk it is wrapped by safeStorage
// (DPAPI on Windows), so a copied profile folder can't be opened on another
// PC or under another Windows user.
export function loadOrCreateSecretsKey(dir: string): Buffer {
  const file = path.join(dir, KEY_FILE);
  const protectedStorage = safeStorage.isEncryptionAvailable();

  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file);
    const hex = protectedStorage ? safeStorage.decryptString(raw) : raw.toString("utf8");
    return Buffer.from(hex.trim(), "hex");
  }

  const key = crypto.randomBytes(32);
  const hex = key.toString("hex");
  fs.mkdirSync(dir, { recursive: true });
  if (protectedStorage) {
    fs.writeFileSync(file, safeStorage.encryptString(hex));
  } else {
    // Linux without a keyring: no OS protection available
    console.warn("[Keystore] safeStorage is unavailable, the secrets key is stored unprotected.");
    fs.writeFileSync(file, hex, { mode: 0o600 });
  }
  return key;
}
