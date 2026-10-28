import path from "path";
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from "electron";
import updater from "electron-updater";
import icon from "../resources/icon.png?asset";
import { setSecretsKey } from "./core/security.ts";
import { onEvent } from "./core/events.ts";
import { loadOrCreateSecretsKey } from "./keystore.ts";
import { openStore, flushStore, addLog } from "./store.ts";
import { registerIpc, LOCAL_UID } from "./ipc.ts";

const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let trayHintShown = false;

// Only our own page may call into the main process
function isTrustedSender(event: IpcMainInvokeEvent) {
  const url = event.senderFrame?.url || "";
  return RENDERER_URL ? url.startsWith(RENDERER_URL) : url.startsWith("file://");
}

function showWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#17130F",
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // External links (Steam Market, market.csgo, profiles) open in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (RENDERER_URL && url.startsWith(RENDERER_URL)) return;
    event.preventDefault();
  });

  // Closing the window keeps automation running in the tray
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: "SteamFarmer Helper", body: "Приложение работает в трее. Выйти можно через значок в трее." }).show();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });

  if (RENDERER_URL) mainWindow.loadURL(RENDERER_URL);
  else mainWindow.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }));
  tray.setToolTip("SteamFarmer Helper");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Открыть", click: showWindow },
    { type: "separator" },
    { label: "Выход", click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on("click", showWindow);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    const dataDir = app.getPath("userData");
    setSecretsKey(loadOrCreateSecretsKey(dataDir));
    openStore(dataDir, (collection) => mainWindow?.webContents.send("store:changed", collection));

    // What the core does on its own (automation) goes straight into the history
    onEvent((event) => addLog({ ...event, id: `s-${event.id}`, ownerUid: LOCAL_UID, source: "server" }));

    registerIpc(isTrustedSender);
    ipcMain.handle("app:version", () => app.getVersion());

    createWindow();
    createTray();

    if (app.isPackaged) updater.autoUpdater.checkForUpdatesAndNotify().catch((err) => console.warn("[Updater]", err.message));
  });

  app.on("before-quit", () => {
    quitting = true;
    flushStore();
  });

  // The tray keeps the app alive; quitting goes through the tray menu
  app.on("window-all-closed", () => {});
}
