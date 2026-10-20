const { app, BrowserWindow, ipcMain, net, shell, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { active24Networks } = require('./discovery.cjs');
const { checkForUpdate, RELEASE_PAGE_PREFIX } = require('./update-check.cjs');

let mainWindow;
let settingsPath;
let logPath;
let settings;
let updateInfo = null;
let updateCheck = null;
let deviceHost = null;
let quitting = false;
let nextCallId = 1;
const pendingCalls = new Map();
const deviceStates = {};
const logs = [];
const UPDATE_CHECK_DELAY_MS = 5_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DEMO_IDS = ['fan', 'windmill'];

const defaultSettings = {
  activeDemo: null,
  devices: {
    fan: { ip: '', port: 502, unitId: 1, autoReconnect: true },
    windmill: { ip: '', port: 502, unitId: 1, autoReconnect: true },
  },
};

function sendToRenderer(channel, payload) {
  // On macOS the app keeps running with no window, so polling may outlive it.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function log(level, source, message) {
  const entry = { timestamp: Date.now(), level, source, message };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  if (logPath) {
    fs.appendFile(logPath, `${new Date(entry.timestamp).toISOString()} ${level.toUpperCase()} [${source}] ${message}\n`, () => {});
  }
  sendToRenderer('hmi:log', entry);
}

async function loadSettings() {
  try {
    const value = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
    return {
      activeDemo: value.activeDemo || null,
      devices: {
        fan: { ...defaultSettings.devices.fan, ...value.devices?.fan },
        windmill: { ...defaultSettings.devices.windmill, ...value.devices?.windmill },
      },
    };
  } catch (error) {
    if (error.code !== 'ENOENT') log('warn', 'app', `Could not read settings: ${error.message}`);
    return structuredClone(defaultSettings);
  }
}

async function saveSettings() {
  const temporary = `${settingsPath}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, settingsPath);
}

function requireDemo(id) {
  if (!DEMO_IDS.includes(id)) throw new Error(`Unknown demo: ${id}`);
  return id;
}

function callDevice(method, ...args) {
  if (!deviceHost) return Promise.reject(new Error('Device communication is restarting. Try again.'));
  return new Promise((resolve, reject) => {
    const callId = nextCallId++;
    pendingCalls.set(callId, { resolve, reject });
    deviceHost.postMessage({ callId, method, args });
  });
}

function onDeviceHostMessage(message) {
  if (message.type === 'state') {
    deviceStates[message.state.id] = message.state;
    sendToRenderer('hmi:state', message.state);
  } else if (message.type === 'log') {
    log(message.level, message.source, message.message);
  } else if (message.type === 'result') {
    const call = pendingCalls.get(message.callId);
    pendingCalls.delete(message.callId);
    if (message.error) call?.reject(new Error(message.error));
    else call?.resolve(message.value);
  }
}

// Device communication runs in a utility process: on macOS the main process is refused
// local network access (EHOSTUNREACH) while a utility process is not. See device-host.cjs.
async function startDeviceHost() {
  const host = utilityProcess.fork(path.join(__dirname, 'device-host.cjs'), [], { serviceName: 'TXOne device communication' });
  deviceHost = host;
  host.on('message', onDeviceHostMessage);
  host.once('exit', (code) => {
    if (deviceHost !== host) return;
    deviceHost = null;
    for (const call of pendingCalls.values()) call.reject(new Error('Device communication stopped'));
    pendingCalls.clear();
    if (quitting) return;
    log('error', 'app', `Device communication stopped (exit code ${code}); restarting`);
    setTimeout(() => startDeviceHost().catch((error) => log('error', 'app', `Could not restart device communication: ${error.message}`)), 1_000);
  });
  Object.assign(deviceStates, await callDevice('init', settings.devices));
  for (const state of Object.values(deviceStates)) sendToRenderer('hmi:state', state);
}

function publicState() {
  return {
    activeDemo: settings.activeDemo,
    devices: { ...deviceStates },
    logs: logs.slice(-150),
    version: app.getVersion(),
    networks: active24Networks(),
    update: updateInfo,
  };
}

function runUpdateCheck() {
  // Demo networks are often offline, so a failed check is logged and otherwise ignored.
  updateCheck ??= checkForUpdate({ currentVersion: app.getVersion(), fetch: net.fetch })
    .then((result) => {
      const newlyAvailable = result.available && result.latestVersion !== updateInfo?.latestVersion;
      updateInfo = result;
      if (newlyAvailable) log('info', 'app', `Version ${result.latestVersion} is available on GitHub`);
      sendToRenderer('hmi:update', updateInfo);
      return updateInfo;
    })
    .catch((error) => {
      log('info', 'app', `Update check skipped: ${error.message}`);
      return updateInfo;
    })
    .finally(() => {
      updateCheck = null;
    });
  return updateCheck;
}

async function selectDemo(id) {
  if (id !== null && !DEMO_IDS.includes(id)) throw new Error('Invalid demo selection');
  for (const otherId of DEMO_IDS) {
    if (otherId !== id && deviceStates[otherId]?.status !== 'disconnected') await callDevice('disconnect', otherId);
  }
  settings.activeDemo = id;
  await saveSettings();
  log('info', 'app', id ? `Selected ${id} demo` : 'Returned to demo selection');
  return publicState();
}

function registerIpc() {
  ipcMain.handle('hmi:get-state', () => publicState());
  ipcMain.handle('hmi:select-demo', (_event, id) => selectDemo(id));
  ipcMain.handle('hmi:update-config', async (_event, id, config) => {
    requireDemo(id);
    if (deviceStates[id]?.status !== 'disconnected') await callDevice('disconnect', id);
    const snapshot = await callDevice('configure', id, config);
    settings.devices[id] = { ...snapshot.config };
    await saveSettings();
    log('info', id, 'Connection settings saved');
    return snapshot;
  });
  ipcMain.handle('hmi:set-auto-reconnect', async (_event, id, enabled) => {
    const next = await callDevice('setAutoReconnect', requireDemo(id), enabled);
    settings.devices[id] = { ...next.config };
    await saveSettings();
    log('info', id, `Automatic reconnect ${next.config.autoReconnect ? 'enabled' : 'disabled'}`);
    return next;
  });
  ipcMain.handle('hmi:connect', async (_event, id) => {
    if (settings.activeDemo !== id) await selectDemo(id);
    return callDevice('connect', requireDemo(id));
  });
  ipcMain.handle('hmi:disconnect', (_event, id) => callDevice('disconnect', requireDemo(id)));
  ipcMain.handle('hmi:retry', (_event, id) => callDevice('retry', requireDemo(id)));
  ipcMain.handle('hmi:command', (_event, id, command, payload) => {
    if (settings.activeDemo !== id) throw new Error('This demo is not active');
    return callDevice('command', requireDemo(id), command, payload);
  });
  ipcMain.handle('hmi:get-log-path', () => logPath);
  ipcMain.handle('hmi:get-networks', () => active24Networks());
  ipcMain.handle('hmi:open-log-folder', () => shell.showItemInFolder(logPath));
  ipcMain.handle('hmi:check-update', () => runUpdateCheck());
  ipcMain.handle('hmi:open-update', () => {
    if (!updateInfo?.url?.startsWith(RELEASE_PAGE_PREFIX)) throw new Error('No update is available');
    return shell.openExternal(updateInfo.url);
  });
  ipcMain.handle('hmi:discover', (_event, id) => callDevice('discover', requireDemo(id)));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1060,
    minHeight: 680,
    show: false,
    backgroundColor: '#202020',
    title: 'TXOne Modbus Demo HMI',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.txone.modbus-demo-hmi');
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  logPath = path.join(app.getPath('userData'), 'hmi.log');
  settings = await loadSettings();
  await startDeviceHost();
  registerIpc();
  createWindow();
  setTimeout(runUpdateCheck, UPDATE_CHECK_DELAY_MS);
  setInterval(runUpdateCheck, UPDATE_CHECK_INTERVAL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  callDevice('disconnectAll').catch(() => {});
});
