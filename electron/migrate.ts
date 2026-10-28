import { HttpError, seal, unseal } from "./core/security.ts";
import * as store from "./store.ts";

// File written by `npm run export:firebase` from the old web version
export type LegacyExport = {
  format: "steamfarmer-web-export";
  version: 1;
  uid: string;
  accounts: Record<string, any>[];
  proxies: Record<string, any>[];
  logs: Record<string, any>[];
};

// Re-encrypts each account's secrets from the old server key (SECRETS_KEY, bound
// to the Firebase uid) to this PC's key, then stores everything locally.
export function importLegacyExport(data: LegacyExport, secretsKeyHex: string, localUid: string) {
  if (!data || data.format !== "steamfarmer-web-export" || !data.uid) {
    throw new HttpError(400, "Это не файл экспорта из веб-версии.");
  }
  const hex = secretsKeyHex.trim().replace(/^SECRETS_KEY=/, "").replace(/^"|"$/g, "");
  const oldKey = Buffer.from(hex, "hex");
  if (oldKey.length !== 32) throw new HttpError(400, "SECRETS_KEY должен состоять из 64 hex-символов.");

  // A wrong key fails on every blob: refuse before writing anything
  const sealed = (data.accounts || []).filter((a) => a.secrets);
  if (sealed.length > 0 && !sealed.some((a) => { try { unseal(a.secrets, data.uid, oldKey); return true; } catch { return false; } })) {
    throw new HttpError(400, "SECRETS_KEY не подходит: ни один аккаунт не расшифровался.");
  }

  let accounts = 0;
  let resealed = 0;
  const failed: string[] = [];

  for (const raw of data.accounts || []) {
    const { id, ownerUid, ...account } = raw;
    if (!id) continue;
    if (account.secrets) {
      try {
        account.secrets = seal(unseal(account.secrets, data.uid, oldKey), localUid);
        resealed++;
      } catch {
        failed.push(account.accountName || id);
        continue;
      }
    }
    store.setDoc("accounts", String(id), account);
    accounts++;
  }

  let proxies = 0;
  for (const { id, ...proxy } of data.proxies || []) {
    if (!id || proxy.deleted) continue;
    store.setDoc("proxies", String(id), proxy);
    proxies++;
  }

  let logs = 0;
  for (const { ownerUid, ...log } of data.logs || []) {
    if (!log.id || typeof log.time !== "number") continue;
    store.addLog(log as store.Doc);
    logs++;
  }

  return { accounts, resealed, proxies, logs, failed };
}
