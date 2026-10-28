// One-off export from the old web version (Firebase) for "Settings → Import from web version".
// Run in the project folder that still has firebase-applet-config.json:
//   npm run export:firebase
// Secrets stay encrypted with the old SECRETS_KEY; the app asks for that key during import.

import fs from "fs";
import path from "path";
import readline from "readline/promises";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { getFirestore, collection, getDocs, query, orderBy, limit } from "firebase/firestore";

const configFile = path.resolve("firebase-applet-config.json");
if (!fs.existsSync(configFile)) {
  console.error("firebase-applet-config.json not found. Run this in the folder of the old web version.");
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const email = (await rl.question("Email for the old site: ")).trim();
const password = await rl.question("Password: ");
rl.close();

const app = initializeApp(config);
const { user } = await signInWithEmailAndPassword(getAuth(app), email, password);
const db = getFirestore(app, config.firestoreDatabaseId);

const read = async (name: string, ...constraints: any[]) => {
  const snap = await getDocs(query(collection(db, "users", user.uid, name), ...constraints));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

const accounts = await read("steamAccounts");
const proxies = await read("proxies");
const logs = await read("logs", orderBy("time", "desc"), limit(2000));

const out = path.resolve("steamfarmer-export.json");
fs.writeFileSync(out, JSON.stringify({ format: "steamfarmer-web-export", version: 1, uid: user.uid, accounts, proxies, logs }, null, 2));
console.log(`Exported ${accounts.length} accounts, ${proxies.length} proxies, ${logs.length} log entries to ${out}`);
console.log("Import it in the app: Settings → Import from web version. Delete the file afterwards.");
process.exit(0);
