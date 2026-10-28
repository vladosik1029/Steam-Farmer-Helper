// Electron downloads its binary in a postinstall step, which sometimes doesn't
// run or fails quietly (network, antivirus). Then `electron-vite dev` stops with
// "Electron uninstall". This runs that step again before dev/build if needed.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const dir = path.resolve("node_modules", "electron");
const installed = () => {
  try {
    const exe = fs.readFileSync(path.join(dir, "path.txt"), "utf8").trim();
    return exe && fs.existsSync(path.join(dir, "dist", exe));
  } catch {
    return false;
  }
};

if (!fs.existsSync(dir)) {
  console.error("Electron is not installed. Run `npm install` first.");
  process.exit(1);
}
if (!installed()) {
  console.log("Downloading Electron (one time, about 100 MB)...");
  const result = spawnSync(process.execPath, [path.join(dir, "install.js")], { stdio: "inherit" });
  if (result.status !== 0 || !installed()) {
    console.error("Electron download failed. Check the internet connection or antivirus and run `npm run dev` again.");
    process.exit(1);
  }
}
