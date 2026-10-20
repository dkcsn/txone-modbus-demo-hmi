const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const ModbusRTU = require('modbus-serial');
const { ConnectionManager } = require('./connection-manager.cjs');
const { fanProfile, windmillProfile, modelMatches } = require('./device-profiles.cjs');
const { discoverArpDevices, active24Networks } = require('./discovery.cjs');

let mainWindow;
let settingsPath;
let logPath;
let settings;
const managers = new Map();
const logs = [];
const profiles = new Map([
  [fanProfile.id, fanProfile],
  [windmillProfile.id, windmillProfile],
]);

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

function requireManager(id) {
  const manager = managers.get(id);
  if (!manager) throw new Error(`Unknown demo: ${id}`);
  return manager;
}

function publicState() {
  return {
    activeDemo: settings.activeDemo,
    devices: Object.fromEntries([...managers].map(([id, manager]) => [id, manager.snapshot()])),
    logs: logs.slice(-150),
    version: app.getVersion(),
    networks: active24Networks(),
  };
}

function createManager(profile) {
  const manager = new ConnectionManager({
    id: profile.id,
    label: profile.label,
    createClient: () => new ModbusRTU(),
    readSnapshot: (client) => profile.readSnapshot(client),
    validateClient: (client) => profile.validateClient(client),
    runCommand: (client, name, payload) => profile.runCommand(client, name, payload),
    log,
  });
  manager.configure(settings.devices[profile.id]);
  manager.on('state', (state) => sendToRenderer('hmi:state', state));
  managers.set(profile.id, manager);
}

async function identifyCandidate(device, profile, config) {
  const base = { ...device, expectedModel: profile.expectedModel };
  if (!device.modbusOpen) return { ...base, verification: 'unreachable', modelMatches: false };

  const client = new ModbusRTU();
  try {
    client.setID(config.unitId || 1);
    client.setTimeout(900);
    await client.connectTCP(device.ip, { port: config.port || 502, timeout: 900 });
    const identity = await profile.readIdentity(client);
    const matches = modelMatches(identity.model, profile.acceptedModels);
    return {
      ...base,
      ...identity,
      vendor: /^E12/i.test(identity.model) ? 'Moxa' : base.vendor,
      verification: matches ? 'match' : 'wrong-model',
      modelMatches: matches,
    };
  } catch (error) {
    return {
      ...base,
      verification: 'unverified',
      modelMatches: false,
      identityError: error.message || String(error),
    };
  } finally {
    try {
      client.destroy?.(() => {});
    } catch {}
  }
}

async function selectDemo(id) {
  if (id !== null && !managers.has(id)) throw new Error('Invalid demo selection');
  for (const [otherId, manager] of managers) {
    if (otherId !== id && manager.snapshot().status !== 'disconnected') await manager.disconnect();
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
    const manager = requireManager(id);
    if (manager.snapshot().status !== 'disconnected') await manager.disconnect();
    manager.configure(config);
    settings.devices[id] = { ...manager.snapshot().config };
    await saveSettings();
    log('info', id, 'Connection settings saved');
    return manager.snapshot();
  });
  ipcMain.handle('hmi:set-auto-reconnect', async (_event, id, enabled) => {
    const manager = requireManager(id);
    const next = manager.setAutoReconnect(enabled);
    settings.devices[id] = { ...next.config };
    await saveSettings();
    log('info', id, `Automatic reconnect ${next.config.autoReconnect ? 'enabled' : 'disabled'}`);
    return next;
  });
  ipcMain.handle('hmi:connect', async (_event, id) => {
    if (settings.activeDemo !== id) await selectDemo(id);
    return requireManager(id).connect();
  });
  ipcMain.handle('hmi:disconnect', (_event, id) => requireManager(id).disconnect());
  ipcMain.handle('hmi:retry', (_event, id) => requireManager(id).retryNow());
  ipcMain.handle('hmi:command', (_event, id, command, payload) => {
    if (settings.activeDemo !== id) throw new Error('This demo is not active');
    return requireManager(id).command(command, payload);
  });
  ipcMain.handle('hmi:get-log-path', () => logPath);
  ipcMain.handle('hmi:get-networks', () => active24Networks());
  ipcMain.handle('hmi:open-log-folder', () => shell.showItemInFolder(logPath));
  ipcMain.handle('hmi:discover', async (_event, id) => {
    const manager = requireManager(id);
    const profile = profiles.get(id);
    const port = manager.snapshot().config.port || 502;
    const config = manager.snapshot().config;
    log('info', id, `Scanning local /24 networks and checking port ${port}`);
    try {
      const devices = await discoverArpDevices(port, [config.ip, '192.168.127.254']);
      const identified = await Promise.all(devices.map((device) => identifyCandidate(device, profile, config)));
      const matches = identified.filter((device) => device.modelMatches).length;
      log('info', id, `Discovery found ${devices.length} candidate(s); ${matches} match ${profile.expectedModel}`);
      return identified;
    } catch (error) {
      log('error', id, `Discovery failed: ${error.message}`);
      throw error;
    }
  });
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
  createManager(fanProfile);
  createManager(windmillProfile);
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const manager of managers.values()) manager.disconnect();
});
