import fs from "fs";
import path from "path";

// Local replacement for Firestore: accounts, proxies and history in one JSON
// file inside the profile folder. Writes are debounced and atomic (tmp + rename).

export type Collection = "accounts" | "proxies" | "logs";
export type Doc = Record<string, any> & { id: string };

type Data = {
  version: 1;
  accounts: Record<string, Doc>;
  proxies: Record<string, Doc>;
  logs: Doc[];
};

const FILE_NAME = "data.json";
const MAX_LOGS = 2000;
const SAVE_DELAY_MS = 300;

let file = "";
let data: Data = { version: 1, accounts: {}, proxies: {}, logs: [] };
let saveTimer: NodeJS.Timeout | null = null;
let onChange: (collection: Collection) => void = () => {};

export function openStore(dir: string, changed: (collection: Collection) => void) {
  file = path.join(dir, FILE_NAME);
  onChange = changed;
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    data = { version: 1, accounts: parsed.accounts || {}, proxies: parsed.proxies || {}, logs: parsed.logs || [] };
  }
}

export function flushStore() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!file) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function changed(collection: Collection) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushStore, SAVE_DELAY_MS);
  onChange(collection);
}

export function listDocs(collection: Collection): Doc[] {
  if (collection === "logs") return data.logs.slice(0, 500);
  return Object.values(data[collection]);
}

export function getDoc(collection: "accounts" | "proxies", id: string): Doc | undefined {
  return data[collection][id];
}

// merge: like Firestore setDoc(..., { merge: true }); unset: fields to delete
export function setDoc(
  collection: "accounts" | "proxies",
  id: string,
  value: Record<string, any>,
  opts: { merge?: boolean; unset?: string[] } = {}
) {
  const next: Doc = { ...(opts.merge ? data[collection][id] : {}), ...value, id };
  for (const key of opts.unset || []) delete next[key];
  data[collection][id] = next;
  changed(collection);
}

export function deleteDoc(collection: "accounts" | "proxies", id: string) {
  delete data[collection][id];
  changed(collection);
}

export function addLog(entry: Doc) {
  if (data.logs.some((l) => l.id === entry.id)) return;
  data.logs.unshift(entry);
  data.logs.sort((a, b) => b.time - a.time);
  if (data.logs.length > MAX_LOGS) data.logs.length = MAX_LOGS;
  changed("logs");
}
