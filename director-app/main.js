'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, net, safeStorage, shell, Menu } = require('electron');
const { DirectorClient } = require('./src/api');
const { SettingsStore } = require('./src/settings');

// Optioneel: eigen map voor instellingen (bv. portable gebruik of tests).
if (process.env.DIRECTOR_USER_DATA) app.setPath('userData', process.env.DIRECTOR_USER_DATA);

let store;
let client;
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Director Aanwezigheden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Externe links in de standaardbrowser openen, nooit in de app zelf.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

/** Wrapt een handler zodat fouten als { ok:false, error } naar de renderer gaan. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return {
        ok: false,
        error: { message: err.message || String(err), status: err.status, body: err.body, url: err.url },
      };
    }
  });
}

app.whenReady().then(() => {
  store = new SettingsStore(app.getPath('userData'), safeStorage);
  // net.fetch gebruikt de netwerkstack van Chromium (systeemproxy, certificaten).
  client = new DirectorClient(store.load(), { fetchImpl: (url, opts) => net.fetch(url, opts) });

  handle('settings:get', () => store.load());
  handle('settings:save', (input) => {
    const saved = store.save(input || {});
    client.updateSettings(saved);
    return saved;
  });
  handle('auth:test', async () => {
    client.clearToken();
    await client.getToken(true);
    return { expiresInSec: Math.round((client.tokenExpires - Date.now()) / 1000) };
  });
  handle('api:organs', () => client.getOrgans());
  handle('api:meetings', (opts) => client.getMeetings(opts || {}));
  handle('api:members', (meetingId) => client.getMembers(meetingId));
  handle('api:updateMember', (meetingId, memberId, patch) => client.updateMember(meetingId, memberId, patch));

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Bestand', submenu: [{ role: 'reload', label: 'Herladen' }, { role: 'toggleDevTools', label: 'Ontwikkelaarstools' }, { type: 'separator' }, { role: 'quit', label: 'Afsluiten' }] },
    { label: 'Bewerken', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Beeld', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ]));

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
