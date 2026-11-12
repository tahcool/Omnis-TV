// Omnis Auxiliary Screens - stand-alone wall-screen app for the Fleetrack auxiliary screens (DBR, WIP, MDR, STS).
//  - No Omnis login, no database keys: data comes from the read-only tv-screens server function,
//    unlocked with a display PIN (stored encrypted with Windows DPAPI via safeStorage).
//  - First run (or Ctrl+Shift+S on a screen) opens Setup: PIN, which report on which monitor, division.
//  - Starts with Windows, keeps the displays awake, reloads itself if a screen crashes, updates itself.
//  - Ctrl+Shift+S = Setup, Ctrl+Shift+Q = close (system-wide shortcuts, so they work whichever screen has focus;
//    Esc does nothing - these are wall screens).
const { app, BrowserWindow, ipcMain, screen, powerSaveBlocker, safeStorage, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ENDPOINT = (!app.isPackaged && process.env.OMNIS_TV_ENDPOINT) || 'https://pfqaeewmlwfayxbgmuaq.supabase.co/functions/v1/tv-screens';
const SCREENS = ['BD', 'WIP', 'DEF', 'STS', 'DSP', 'SBR', 'ALL'];
const FETCH_MIN_MS = 30 * 1000;      // several screens share one fetch
const FETCH_TIMEOUT_MS = 25 * 1000;

// Development only: separate settings folder for tests (before the single-instance lock, which is per folder)
if (!app.isPackaged && process.env.OMNIS_TV_USERDATA) app.setPath('userData', process.env.OMNIS_TV_USERDATA);
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => openSetup());
Menu.setApplicationMenu(null);

// ── Config (userData/config.json) ─────────────────────────────────────────
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const cacheFile = () => path.join(app.getPath('userData'), 'tv-cache.json');
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return dflt; } }
function writeJson(f, v) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); } catch (e) { console.error('[TV] write', f, e.message); } }
let config = null;
function loadConfig() {
  config = readJson(cfgFile(), {}) || {};
  if (config.autoStart === undefined) config.autoStart = true;
  // Random id of this PC for remote management (Admin Console > Remote Support > Auxiliary Screens)
  if (!config.deviceId) { config.deviceId = 'tv-' + crypto.randomUUID(); writeJson(cfgFile(), config); }
  return config;
}
function getPin() {
  if (config.pinEnc && safeStorage.isEncryptionAvailable()) { try { return safeStorage.decryptString(Buffer.from(config.pinEnc, 'base64')); } catch (_) { return ''; } }
  return config.pin || '';
}
function setPin(pin) {
  delete config.pin; delete config.pinEnc;
  if (!pin) return;
  if (safeStorage.isEncryptionAvailable()) config.pinEnc = safeStorage.encryptString(pin).toString('base64');
  else config.pin = pin;
}

// ── Data: one shared fetch, cached on disk for offline use ────────────────
let cache = null, lastFetch = 0, inflight = null;
const tvStatus = { update: '', last_error: '' };   // reported to the Admin Console every minute
async function callEndpoint(pin) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'x-tv-pin': pin, 'Content-Type': 'application/json' }, body: '{}', signal: ctl.signal });
    let body = null; try { body = await res.json(); } catch (_) {}
    if (res.status === 404) throw new Error('The screens service is not switched on yet on the server (tv-screens function not deployed) - ask your Omnis administrator');
    if (!res.ok || !body || !body.ok) throw new Error((body && body.error) || ('Server error ' + res.status));
    return body;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Server did not answer in time' : (e.message || String(e)));
  } finally { clearTimeout(t); }
}
// AI analyst briefing: the screen sends its summary figures; the server answers from its hourly cache or asks OpenAI
const briefMemo = {};   // division -> { at, result } so several monitors do not each ask
async function getBriefing(payload) {
  const division = payload && payload.division === 'sinopower' ? 'sinopower' : 'fleetrack';
  const m = briefMemo[division];
  if (m && Date.now() - m.at < 10 * 60 * 1000) return m.result;
  const pin = getPin();
  if (!pin) return { ok: false, error: 'No PIN set' };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 150000);   // the deep analysis can take a minute or two
  try {
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'x-tv-pin': pin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'briefing', division, summary: payload.summary }), signal: ctl.signal });
    let body = null; try { body = await res.json(); } catch (_) {}
    const result = (res.ok && body && body.ok) ? body : { ok: false, error: (body && body.error) || ('Server error ' + res.status) };
    briefMemo[division] = { at: Date.now(), result };
    return result;
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Server did not answer in time' : (e.message || String(e)) };
  } finally { clearTimeout(t); }
}
async function getData() {
  if (!cache) cache = readJson(cacheFile(), null);
  if (cache && Date.now() - lastFetch < FETCH_MIN_MS) return Object.assign({}, cache, { offline: false });
  if (!inflight) {
    inflight = (async () => {
      const pin = getPin();
      if (!pin) throw new Error('No PIN set - press Ctrl+Shift+S');
      const body = await callEndpoint(pin);
      cache = { mach: body.mach, bd: body.bd, def: body.def, disp: body.disp || null, hist: body.hist || null, pics: body.pics || null, fsp: body.fsp || null, fetchedAt: Date.now() };
      lastFetch = Date.now();
      tvStatus.last_error = '';
      writeJson(cacheFile(), cache);
      return cache;
    })().finally(() => { inflight = null; });
  }
  try { return Object.assign({}, await inflight, { offline: false }); }
  catch (e) {
    lastFetch = Date.now() - FETCH_MIN_MS + 10000; // retry in ~10 s, not on every screen tick
    tvStatus.last_error = e.message;
    if (!/No PIN set/.test(e.message)) tvReport('tv.data', 'Screen data could not be loaded: ' + e.message, { severity: cache ? 'warn' : 'error' });
    return cache ? Object.assign({}, cache, { offline: true, error: e.message }) : { offline: true, error: e.message };
  }
}

// ── Displays ──────────────────────────────────────────────────────────────
function displays() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({ id: d.id, index: i + 1, primary: d.id === primary.id, width: d.size.width, height: d.size.height, label: d.label || '', bounds: d.bounds }));
}
function defaultScreens() {
  const ds = displays();
  if (ds.length === 1) return [{ displayId: ds[0].id, displayIndex: 1, screen: 'ALL', div: 'fleetrack' }];
  const order = ['BD', 'WIP', 'DEF', 'STS'];
  let k = 0;
  return ds.map(d => ({ displayId: d.id, displayIndex: d.index, screen: d.primary ? 'OFF' : order[k++ % order.length], div: 'fleetrack' }));
}

// ── Error log: crashes, freezes, page errors and failed data loads go to ops_error_log ──────
// Sent with the display PIN to the tv-screens function (no database keys on the TV PC), grouped with a
// count, every 2 minutes; the same error at most every 15 minutes. Never throws or blocks a screen.
const tvErrors = new Map();
let tvErrTimer = null;
function tvReport(fn, message, opts = {}) {
  try {
    const msg = String(message || '').slice(0, 2000);
    if (!msg) return;
    const key = fn + '|' + msg.split('\n')[0].toLowerCase().replace(/\d+/g, '#').slice(0, 200);
    let e = tvErrors.get(key);
    if (!e) {
      if (tvErrors.size > 150) return;
      e = { fn, message: msg, severity: opts.severity === 'warn' ? 'warn' : 'error', page: opts.page || null, display: opts.display ?? null, screen: opts.screen || null, count: 0, sentAt: 0, first: Date.now(), last: 0 };
      tvErrors.set(key, e);
    }
    e.count++; e.last = Date.now();
    if (!tvErrTimer) { tvErrTimer = setTimeout(tvFlush, 2 * 60 * 1000); if (tvErrTimer.unref) tvErrTimer.unref(); }
  } catch (_) { /* ignore */ }
}
async function tvFlush() {
  tvErrTimer = null;
  try {
    const pin = getPin();
    const now = Date.now();
    const due = [...tvErrors.values()].filter(e => e.count > 0 && (!e.sentAt || now - e.sentAt >= 15 * 60 * 1000)).slice(0, 30);
    if (!pin || !due.length) return;
    const errors = due.map(e => ({ fn: e.fn, message: e.message, severity: e.severity, occurrences: e.count, page: e.page, display: e.display, screen: e.screen, version: app.getVersion(), first_at: new Date(e.first).toISOString(), last_at: new Date(e.last).toISOString() }));
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'x-tv-pin': pin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'report', errors }), signal: AbortSignal.timeout(20000) });
    if (res.ok) due.forEach(e => { e.count = 0; e.sentAt = now; });
  } catch (_) { /* offline: try again later */ }
  finally { if (!tvErrTimer && [...tvErrors.values()].some(e => e.count > 0)) { tvErrTimer = setTimeout(tvFlush, 2 * 60 * 1000); if (tvErrTimer.unref) tvErrTimer.unref(); } }
}
const TV_NOISE = /Electron Security Warning|DevTools|source ?map|Autofill\.|\[Deprecation\]|favicon|ResizeObserver|tile\.openstreetmap|basemaps\.|arcgisonline|fonts\.(googleapis|gstatic)|unpkg\.com/i;
function watchErrors(win, entry, displayIndex) {
  const wc = win.webContents;
  const where = () => { const sc = entry.sc || {}; return { page: 'kiosk ' + (sc.screen || '') + (sc.pair ? '+' + sc.pair : ''), display: displayIndex, screen: (sc.screen || '') + (sc.pair ? ' + ' + sc.pair : '') + (sc.div === 'sinopower' ? ' Sinopower' : '') }; };
  wc.on('console-message', (event, level, message, line, sourceId) => {
    try {
      let lv = level, msg = message, ln = line, src = sourceId;
      if (event && typeof event === 'object' && typeof event.level === 'string') { lv = { debug: 0, verbose: 0, info: 1, warning: 2, error: 3 }[event.level]; msg = event.message; ln = event.lineNumber; src = event.sourceId; }
      if (lv !== 3 || !msg || TV_NOISE.test(msg)) return;
      tvReport('tv.page', msg + (src ? '\n    at ' + String(src).split(/[\\/]/).slice(-2).join('/') + (ln ? ':' + ln : '') : ''), where());
    } catch (_) { /* ignore */ }
  });
  wc.on('render-process-gone', (_e, d) => tvReport('tv.crash', 'A screen crashed (' + ((d && d.reason) || 'unknown') + ') and was reloaded', where()));
  win.on('unresponsive', () => tvReport('tv.freeze', 'A screen stopped responding and was reloaded', where()));
}

// ── Windows ───────────────────────────────────────────────────────────────
// One kiosk window per monitor (displayId -> { win, key, sc }); saving setup reuses the windows,
// so screens change in place instead of closing and re-opening.
const kiosks = new Map();
let setupWin = null, setupOpenedAt = 0;
const lockDown = (win) => {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });
};
// Fallback when another program already owns the system-wide shortcuts
function localShortcuts(win) {
  win.webContents.on('before-input-event', (e, input) => {
    if (shortcutsGlobal || input.type !== 'keyDown' || input.isAutoRepeat || !input.control || !input.shift) return;
    const k = String(input.key || '').toLowerCase();
    if (k === 's') { e.preventDefault(); openSetup(); }
    if (k === 'q') { e.preventDefault(); quitNow(); }
  });
}
// Two screens on one monitor: sc.pair = second screen, sc.swap = seconds between them (default 60)
const pairOf = (sc) => (sc.pair && sc.pair !== sc.screen && SCREENS.includes(sc.pair) ? sc.pair : '');
const swapOf = (sc) => Math.max(10, Math.min(3600, Number(sc.swap) || 60));
const keyOf = (sc) => sc.screen + '|' + (sc.div || 'fleetrack') + '|' + (sc.region || '') + '|' + pairOf(sc) + '|' + (pairOf(sc) ? swapOf(sc) : '');
const loadScreen = (win, sc) => win.loadFile(path.join(__dirname, 'systems', 'fleetrack', 'kiosk.html'), { query: Object.assign({ screen: sc.screen, div: sc.div || 'fleetrack' }, sc.region ? { region: sc.region } : {}, pairOf(sc) ? { pair: pairOf(sc), swap: String(swapOf(sc)) } : {}) });
function openKiosk(d, sc) {
  const b = d.bounds;
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, frame: false, fullscreen: true, kiosk: true, show: false,
    autoHideMenuBar: true, backgroundColor: '#e2e8f0', title: 'Omnis Auxiliary Screens - ' + sc.screen,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  const entry = { win, key: keyOf(sc), sc };
  kiosks.set(d.id, entry);
  win.on('closed', () => { if (kiosks.get(d.id) === entry) kiosks.delete(d.id); });
  lockDown(win); localShortcuts(win); watchErrors(win, entry, d.index);
  // Self-healing: reload a crashed or frozen screen
  win.webContents.on('render-process-gone', () => setTimeout(() => { if (!win.isDestroyed()) loadScreen(win, entry.sc); }, 3000));
  win.on('unresponsive', () => setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, 5000));
  win.once('ready-to-show', () => { win.setBounds(b); win.show(); });
  loadScreen(win, sc);
}
function startScreens() {
  const ds = displays();
  const list = (config.screens || []).filter(s => SCREENS.includes(s.screen));
  const wanted = new Map();
  for (const sc of list) {
    const d = ds.find(x => x.id === sc.displayId) || ds.find(x => x.index === sc.displayIndex);
    if (d && !wanted.has(d.id)) wanted.set(d.id, { d, sc });
  }
  // Monitor missing (e.g. TV switched off at boot): show the first configured screen on the main display
  if (!wanted.size && list.length) { const d = ds.find(x => x.primary) || ds[0]; wanted.set(d.id, { d, sc: list[0] }); }
  for (const [id, k] of kiosks) if (!wanted.has(id)) { try { k.win.destroy(); } catch (_) {} kiosks.delete(id); }
  for (const [id, { d, sc }] of wanted) {
    const k = kiosks.get(id);
    if (k && !k.win.isDestroyed()) {
      if (k.key !== keyOf(sc)) { k.key = keyOf(sc); k.sc = sc; loadScreen(k.win, sc); }
      continue;
    }
    openKiosk(d, sc);
  }
  return wanted.size;
}
function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) { setupWin.show(); setupWin.moveTop(); setupWin.focus(); return; }
  if (Date.now() - setupOpenedAt < 1500) return;   // ignore a held / repeated shortcut
  setupOpenedAt = Date.now();
  const wa = screen.getPrimaryDisplay().workArea;
  const W = Math.min(1200, wa.width - 40), H = Math.min(800, wa.height - 40);
  setupWin = new BrowserWindow({
    width: W, height: H, x: Math.round(wa.x + (wa.width - W) / 2), y: Math.round(wa.y + (wa.height - H) / 2),
    minWidth: 960, minHeight: 560, title: 'Omnis Auxiliary Screens - Setup', frame: false, autoHideMenuBar: true, backgroundColor: '#4c110d', show: false,
    icon: path.join(__dirname, 'assets', 'images', 'omnis-notification-icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Above the full-screen wall screens, without taking them out of full screen
  if (kiosks.size) setupWin.setAlwaysOnTop(true, 'screen-saver');
  lockDown(setupWin); localShortcuts(setupWin);
  setupWin.loadFile(path.join(__dirname, 'setup.html'));
  setupWin.once('ready-to-show', () => { setupWin.show(); setupWin.focus(); });
  setupWin.on('closed', () => {
    setupWin = null;
    if (kiosks.size) return;   // screens keep running underneath
    if (getPin() && (config.screens || []).some(s => SCREENS.includes(s.screen))) startScreens();
    else app.quit();
  });
}
function quitNow() {
  for (const k of kiosks.values()) { try { k.win.destroy(); } catch (_) {} }
  kiosks.clear();
  if (setupWin && !setupWin.isDestroyed()) { try { setupWin.destroy(); } catch (_) {} }
  app.quit();
}
let shortcutsGlobal = false;
function registerShortcuts() {
  try {
    const a = globalShortcut.register('CommandOrControl+Shift+S', openSetup);
    const b = globalShortcut.register('CommandOrControl+Shift+Q', quitNow);
    shortcutsGlobal = a && b;
    if (shortcutsGlobal) console.log('[Aux] shortcuts Ctrl+Shift+S / Ctrl+Shift+Q registered');
    if (!shortcutsGlobal) { globalShortcut.unregisterAll(); console.warn('[Aux] shortcuts in use by another program - using window shortcuts'); }
  } catch (_) { shortcutsGlobal = false; }
}

// ── IPC ───────────────────────────────────────────────────────────────────
ipcMain.handle('tv:getData', () => getData());
ipcMain.handle('tv:briefing', (_e, payload) => getBriefing(payload || {}));
ipcMain.handle('tv:setup:get', () => ({
  version: app.getVersion(), hasPin: !!getPin(), autoStart: config.autoStart !== false,
  screens: (config.screens && config.screens.length) ? config.screens : defaultScreens(),
  displays: displays(),
}));
ipcMain.handle('tv:setup:test', async (_e, pin) => {
  try {
    const body = await callEndpoint(String(pin || '').trim() || getPin());
    const fsd = body.bd.filter(r => r.responsibility === 'FSD').length, wsd = body.bd.filter(r => r.responsibility === 'WSD').length;
    const d = body.disp;
    const disp = d ? `, ${(d.plans || []).length} dispatch jobs, ${(d.locs || []).length} technician positions` : '';
    return { ok: true, summary: `${fsd} breakdowns (DBR), ${wsd} in the workshop (WIP), ${body.def.length} major defects, ${body.mach.length} machines${disp} - both divisions`,
      warn: d ? '' : 'Live Dispatch needs a server update: redeploy the tv-screens function (the reports work).' };
  } catch (e) { return { ok: false, error: e.message }; }
});
function normScreens(list) {
  return (list || []).map(s => {
    const screen = SCREENS.includes(s.screen) ? s.screen : 'OFF';
    const pair = SCREENS.includes(s.pair) && s.pair !== screen && screen !== 'OFF' ? s.pair : '';
    return { displayId: Number(s.displayId), displayIndex: Number(s.displayIndex), screen, div: s.div === 'sinopower' ? 'sinopower' : 'fleetrack', region: ['north', 'south'].includes(s.region) ? s.region : '',
      pair, swap: pair ? Math.max(10, Math.min(3600, Math.round(Number(s.swap) || 60))) : 60 };
  });
}
ipcMain.handle('tv:setup:save', async (_e, data) => {
  const pin = String((data && data.pin) || '').trim();
  if (pin) setPin(pin);
  config.screens = normScreens(data && data.screens);
  config.autoStart = !!(data && data.autoStart);
  writeJson(cfgFile(), config);
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.autoStart, path: process.execPath });
  lastFetch = 0;
  const n = startScreens();
  if (setupWin && !setupWin.isDestroyed()) setupWin.close();
  return { ok: true, opened: n };
});
function identifyScreens() {
  for (const d of displays()) {
    const w = new BrowserWindow({ x: d.bounds.x + Math.round(d.bounds.width / 2) - 160, y: d.bounds.y + Math.round(d.bounds.height / 2) - 160, width: 320, height: 320, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false });
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:Segoe UI,sans-serif;background:transparent"><div style="width:280px;height:280px;background:linear-gradient(135deg,#8b2219,#4c110d);color:#fff;border:1px solid rgba(255,255,255,.25);display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 20px 60px rgba(0,0,0,.4)"><div style="font-size:150px;font-weight:800;line-height:1">${d.index}</div><div style="font-size:20px;opacity:.75">Screen ${d.index}${d.primary ? ' (main)' : ''}</div></div></body>`));
    w.once('ready-to-show', () => w.showInactive());
    setTimeout(() => { try { w.destroy(); } catch (_) {} }, 3500);
  }
  return { ok: true };
}
ipcMain.handle('tv:setup:identify', () => identifyScreens());
ipcMain.handle('tv:quit', () => quitNow());
ipcMain.handle('tv:win:minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.handle('tv:win:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
// Setup window: grow / shrink to its content so nothing needs scrolling (up to the screen height)
ipcMain.handle('tv:win:fit', (e, h) => {
  const w = BrowserWindow.fromWebContents(e.sender); if (!w || !h) return;
  const wa = screen.getDisplayMatching(w.getBounds()).workArea;
  const [cw] = w.getContentSize();
  const nh = Math.min(Math.ceil(h), wa.height - 24);
  w.setContentSize(cw, nh);
  const b = w.getBounds();
  w.setPosition(b.x, Math.max(wa.y + 12, Math.round(wa.y + (wa.height - b.height) / 2)));
});

// ── Updates (GitHub releases of the Omnis-TV repo - separate from the main Omnis app) ────────────────────────
let updater = null;
function setupUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (_) { return; }
  updater = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.on('error', (e) => { tvStatus.update = 'failed: ' + String((e && e.message) || e).slice(0, 160); console.warn('[TV] update check failed:', e && e.message); tvReport('tv.updater', 'Update check failed: ' + ((e && e.message) || e), { severity: 'warn' }); });
  autoUpdater.on('checking-for-update', () => { tvStatus.update = 'checking'; });
  autoUpdater.on('update-not-available', () => { tvStatus.update = 'up to date'; });
  autoUpdater.on('update-available', (i) => { tvStatus.update = 'downloading v' + ((i && i.version) || '?'); });
  autoUpdater.on('download-progress', (p) => { tvStatus.update = 'downloading ' + Math.round((p && p.percent) || 0) + '%'; });
  autoUpdater.on('update-downloaded', (i) => {
    tvStatus.update = 'installing v' + ((i && i.version) || '?');
    hello();   // tell the Admin Console before restarting
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 5000);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 60 * 1000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

// ── Remote management (no keyboard / mouse on the TV PCs) ──────────────────────────────────
// Every minute the app reports in to the tv-screens function (with the display PIN) and runs the commands a super
// admin queued in the Admin Console > Remote Support: update, restart, reload, screenshot, set_screens, identify.
// After a command it checks in every 15 s for 5 minutes, so follow-up commands are quick.
const HELLO_MS = 60 * 1000, HELLO_BUSY_MS = 15 * 1000;
let helloTimer = null, helloBusy = false, busyUntil = 0;
function scheduleHello() {
  clearTimeout(helloTimer);
  helloTimer = setTimeout(hello, Date.now() < busyUntil ? HELLO_BUSY_MS : HELLO_MS);
}
async function postEndpoint(pin, body, timeoutMs) {
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'x-tv-pin': pin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs || 20000) });
  let out = null; try { out = await res.json(); } catch (_) { /* not json */ }
  if (!res.ok || !out || !out.ok) throw new Error((out && out.error) || ('Server error ' + res.status));
  return out;
}
async function hello() {
  if (helloBusy) return;
  helloBusy = true;
  try {
    const pin = getPin();
    if (!pin || !config || !config.deviceId) return;
    const body = {
      action: 'hello', device_id: config.deviceId, name: os.hostname(), version: app.getVersion(),
      displays: displays().map(d => ({ index: d.index, primary: d.primary, width: d.width, height: d.height, label: d.label })),
      screens: (config.screens || []).filter(s => SCREENS.includes(s.screen)).map(s => ({ display: s.displayIndex, screen: s.screen, pair: pairOf(s) || null, div: s.div || 'fleetrack', region: s.region || null })),
      status: { update: tvStatus.update || null, last_error: tvStatus.last_error || null, showing: kiosks.size, setup_open: !!(setupWin && !setupWin.isDestroyed()), uptime_min: Math.round(process.uptime() / 60) },
    };
    const out = await postEndpoint(pin, body, 20000);
    for (const c of (out.commands || [])) {
      busyUntil = Date.now() + 5 * 60 * 1000;
      let ok = true, result = null, after = null;
      try { ({ result, after } = await runTvCommand(c)); }
      catch (e) { ok = false; result = { error: e.message || String(e) }; }
      try { await postEndpoint(pin, { action: 'command_result', device_id: config.deviceId, id: c.id, ok, result }, 60000); }
      catch (e) { console.warn('[TV] result not sent:', e.message); }
      if (after) { setTimeout(after, 1000); break; }
    }
  } catch (e) {
    console.warn('[TV] hello failed:', e.message);
  } finally {
    helloBusy = false;
    scheduleHello();
  }
}
async function runTvCommand(c) {
  switch (c.command) {
    case 'update': {
      if (!updater) throw new Error('Updates only work in the installed app');
      const r = await updater.checkForUpdates();
      const v = r && r.updateInfo && r.updateInfo.version;
      const current = app.getVersion();
      return { result: { current, latest: v || current, update_available: !!(v && v !== current), note: v && v !== current ? 'Downloading; the app restarts by itself when it is installed.' : 'Already on the latest version.' } };
    }
    case 'restart':
      return { result: { restarting: true }, after: () => { app.relaunch(); app.exit(0); } };
    case 'reload': {
      let n = 0;
      for (const k of kiosks.values()) { try { if (!k.win.isDestroyed()) { k.win.webContents.reloadIgnoringCache(); n++; } } catch (_) { /* ignore */ } }
      lastFetch = 0;
      return { result: { reloaded: n } };
    }
    case 'screenshot': {
      const images = [];
      const wins = [...kiosks.values()].map(k => ({ win: k.win, label: 'Monitor ' + (k.sc.displayIndex || '?') + ': ' + k.sc.screen + (pairOf(k.sc) ? ' + ' + pairOf(k.sc) : '') }));
      if (setupWin && !setupWin.isDestroyed()) wins.push({ win: setupWin, label: 'Setup window (open)' });
      for (const w of wins) {
        try {
          if (w.win.isDestroyed()) continue;
          let img = await w.win.webContents.capturePage();
          const sz = img.getSize();
          if (sz.width > 1280) img = img.resize({ width: 1280, quality: 'good' });
          images.push({ label: w.label, data: 'data:image/jpeg;base64,' + img.toJPEG(60).toString('base64') });
        } catch (e) { images.push({ label: w.label + ' (could not capture: ' + e.message + ')', data: '' }); }
      }
      return { result: { images } };
    }
    case 'set_screens': {
      const list = c.payload && Array.isArray(c.payload.screens) ? c.payload.screens : null;
      if (!list) throw new Error('No screens given');
      config.screens = normScreens(list);
      writeJson(cfgFile(), config);
      lastFetch = 0;
      return { result: { opened: startScreens() } };
    }
    case 'identify':
      identifyScreens();
      return { result: { shown: displays().length } };
    default:
      throw new Error('Unknown command: ' + c.command);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadConfig();
  powerSaveBlocker.start('prevent-display-sleep');
  registerShortcuts();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.autoStart !== false, path: process.execPath });
  if (getPin() && (config.screens || []).some(s => SCREENS.includes(s.screen))) startScreens();
  else openSetup();
  // A monitor plugged in or out: lay the screens out again
  let t = null;
  const relayout = () => { clearTimeout(t); t = setTimeout(() => { if (!setupWin && getPin()) startScreens(); }, 4000); };
  screen.on('display-added', relayout);
  screen.on('display-removed', relayout);
  // Fresh start once a day at 04:00 (keeps long-running screens healthy)
  setInterval(() => { const n = new Date(); if (n.getHours() === 4 && n.getMinutes() === 0) for (const k of kiosks.values()) { try { k.win.webContents.reloadIgnoringCache(); } catch (_) {} } }, 60 * 1000);
  setupUpdates();
  helloTimer = setTimeout(hello, 15 * 1000);
});
app.on('window-all-closed', () => { /* stay alive while setup re-opens screens */ if (!setupWin && !kiosks.size) app.quit(); });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (_) {} });
