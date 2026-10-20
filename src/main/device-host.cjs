// Runs all device communication (Modbus TCP, discovery, identity checks) in an Electron
// utility process. macOS Local Network privacy refuses plain sockets from the app's main
// process with EHOSTUNREACH and never prompts, while a utility process is allowed through.
const ModbusRTU = require('modbus-serial');
const { ConnectionManager } = require('./connection-manager.cjs');
const { fanProfile, windmillProfile, modelMatches } = require('./device-profiles.cjs');
const { discoverArpDevices } = require('./discovery.cjs');

const FACTORY_ADDRESS = '192.168.127.254';
const profiles = new Map([
  [fanProfile.id, fanProfile],
  [windmillProfile.id, windmillProfile],
]);
const managers = new Map();

function send(message) {
  process.parentPort.postMessage(message);
}

function log(level, source, message) {
  send({ type: 'log', level, source, message });
}

function requireManager(id) {
  const manager = managers.get(id);
  if (!manager) throw new Error(`Unknown demo: ${id}`);
  return manager;
}

function snapshots() {
  return Object.fromEntries([...managers].map(([id, manager]) => [id, manager.snapshot()]));
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

const handlers = {
  init(devices) {
    for (const profile of profiles.values()) {
      const manager = new ConnectionManager({
        id: profile.id,
        label: profile.label,
        createClient: () => new ModbusRTU(),
        readSnapshot: (client) => profile.readSnapshot(client),
        validateClient: (client) => profile.validateClient(client),
        runCommand: (client, name, payload) => profile.runCommand(client, name, payload),
        log,
      });
      manager.configure(devices[profile.id]);
      manager.on('state', (state) => send({ type: 'state', state }));
      managers.set(profile.id, manager);
    }
    return snapshots();
  },
  configure(id, config) {
    const manager = requireManager(id);
    manager.configure(config);
    return manager.snapshot();
  },
  setAutoReconnect: (id, enabled) => requireManager(id).setAutoReconnect(enabled),
  connect: (id) => requireManager(id).connect(),
  disconnect: (id) => requireManager(id).disconnect(),
  retry: (id) => requireManager(id).retryNow(),
  command: (id, name, payload) => requireManager(id).command(name, payload),
  disconnectAll: () => Promise.all([...managers.values()].map((manager) => manager.disconnect())),
  async discover(id) {
    const config = requireManager(id).snapshot().config;
    const profile = profiles.get(id);
    const port = config.port || 502;
    log('info', id, `Scanning local /24 networks and checking port ${port}`);
    try {
      const devices = await discoverArpDevices(port, [config.ip, FACTORY_ADDRESS]);
      const identified = await Promise.all(devices.map((device) => identifyCandidate(device, profile, config)));
      const matches = identified.filter((device) => device.modelMatches).length;
      log('info', id, `Discovery found ${devices.length} candidate(s); ${matches} match ${profile.expectedModel}`);
      return identified;
    } catch (error) {
      log('error', id, `Discovery failed: ${error.message}`);
      throw error;
    }
  },
};

process.parentPort.on('message', async ({ data }) => {
  const { callId, method, args = [] } = data;
  try {
    if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown device host method: ${method}`);
    send({ type: 'result', callId, value: await handlers[method](...args) });
  } catch (error) {
    send({ type: 'result', callId, error: error.message || String(error) });
  }
});
