import fs from "fs";
import path from "path";
import crypto from "crypto";
import { safeStorage } from "electron";

const KEY_FILE = "secrets.key";

// The key that encrypts Steam secrets. On disk it is wrapped by safeStorage
// (DPAPI on Windows), so a copied profile folder can't be opened on another
// PC or under another Windows user.
export async function loadOrCreateSecretsKey(dir: string): Promise<Buffer> {
  const file = path.join(dir, KEY_FILE);
  const protectedStorage = await safeStorage.isAsyncEncryptionAvailable();

  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file);
    if (!protectedStorage) return Buffer.from(raw.toString("utf8").trim(), "hex");
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(raw);
    if (shouldReEncrypt) fs.writeFileSync(file, await safeStorage.encryptStringAsync(result));
    return Buffer.from(result.trim(), "hex");
  }

  const key = crypto.randomBytes(32);
  const hex = key.toString("hex");
  fs.mkdirSync(dir, { recursive: true });
  if (protectedStorage) {
    fs.writeFileSync(file, await safeStorage.encryptStringAsync(hex));
  } else {
    // Linux without a keyring: no OS protection available
    console.warn("[Keystore] safeStorage is unavailable, the secrets key is stored unprotected.");
    fs.writeFileSync(file, hex, { mode: 0o600 });
  }
  return key;
}
