const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { ConnectionManager, reconnectDelay } = require('../src/main/connection-manager.cjs');
const {
  windmillProfile,
  parseFanCoils,
  indicatorForValue,
  WINDMILL_MAX_OUTPUT,
  WINDMILL_NOMINAL_RPM,
  parseWindmillRegisters,
  wordsToAscii,
  formatMac,
  formatFirmware,
  modelMatches,
  readMoxaIdentity,
} = require('../src/main/device-profiles.cjs');
const { parseArpTable, mergeDiscoveryResults, active24Networks, validIPv4 } = require('../src/main/discovery.cjs');

test('reconnect delay backs off and is capped', () => {
  assert.equal(reconnectDelay(1, () => 0), 500);
  assert.equal(reconnectDelay(2, () => 0), 1_000);
  assert.equal(reconnectDelay(8, () => 0), 10_000);
  assert.equal(reconnectDelay(8, () => 1), 12_000);
});

test('fan coils preserve the legacy low/high mapping', () => {
  assert.deepEqual(parseFanCoils([false, false]), { mode: 'off', running: false, speed: 0 });
  assert.deepEqual(parseFanCoils([true, true]), { mode: 'low', running: true, speed: 55 });
  assert.deepEqual(parseFanCoils([true, false]), { mode: 'high', running: true, speed: 100 });
});

test('windmill indicator follows the original thresholds', () => {
  assert.equal(indicatorForValue(0), 0);
  assert.equal(indicatorForValue(600), 820);
  assert.equal(indicatorForValue(2_600), 3_277);
  assert.equal(indicatorForValue(3_100), 3_769);
  assert.equal(indicatorForValue(4_095), 4_096);
});

test('windmill registers expose the measured emergency-stop state and the original 7.5 V scale', () => {
  assert.equal(WINDMILL_MAX_OUTPUT, 3_072);
  assert.equal(WINDMILL_NOMINAL_RPM, 30);
  assert.deepEqual(parseWindmillRegisters([3_072, 4_095, 820]), {
    rawSpeed: 3_072,
    rpm: 30,
    percent: 100,
    outputVolts: 7.5,
    enableOutput: 4_095,
    indicatorOutput: 820,
    emergencyStopActive: false,
  });
  assert.equal(parseWindmillRegisters([0, 0, 0]).emergencyStopActive, true);
  assert.deepEqual(parseWindmillRegisters([4_096, 4_095, 4_096]), {
    rawSpeed: 4_096,
    rpm: 40,
    percent: 133,
    outputVolts: 10,
    enableOutput: 4_095,
    indicatorOutput: 4_096,
    emergencyStopActive: false,
  });
});

test('windmill speed commands cannot exceed the original 7.5 V demo limit', async () => {
  const writes = [];
  const client = {
    async writeRegister(address, value) { writes.push([address, value]); },
  };
  await windmillProfile.runCommand(client, 'windmill-speed', { value: 4_096 });
  assert.deepEqual(writes, [[1024, 3_072], [1026, 3_277]]);
});

test('PLC word conversion is stable', () => {
  assert.equal(wordsToAscii([0x5458, 0x4f6e, 0x6500]), 'TXOne');
  assert.equal(formatMac([0x0011, 0x2233, 0x4455]), '00:11:22:33:44:55');
  assert.equal(formatFirmware([0x0102, 0x0300]), 'v1.2.3');
  assert.equal(modelMatches('ioLogik E1214', ['E1214', 'E1214-T']), true);
  assert.equal(modelMatches('E1241', ['E1214', 'E1214-T']), false);
});

test('Moxa identity uses the documented read-only register lengths', async () => {
  const calls = [];
  const responses = new Map([
    ['5000:10', [0x4531, 0x3234, 0x3100, 0, 0, 0, 0, 0, 0, 0]],
    ['5024:3', [0x0090, 0xe8bc, 0xa4a0]],
    ['5029:2', [0x0204, 0x0100]],
    ['5040:30', [0x5769, 0x6e64, 0x6d69, 0x6c6c, 0, ...Array(25).fill(0)]],
  ]);
  const client = {
    async readInputRegisters(address, length) {
      calls.push([address, length]);
      return { data: responses.get(`${address}:${length}`) };
    },
  };
  assert.deepEqual(await readMoxaIdentity(client), {
    model: 'E1241',
    mac: '00:90:E8:BC:A4:A0',
    firmware: 'v2.4.1',
    deviceName: 'Windmill',
  });
  assert.deepEqual(calls, [[5000, 10], [5024, 3], [5029, 2], [5040, 30]]);
});

test('ARP discovery parses macOS and Windows output', () => {
  const output = `
? (192.168.1.20) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]
  192.168.1.30          00-90-E8-12-34-56     dynamic
? (192.168.127.250) at 0:90:e8:bc:a4:a0 on en11 ifscope [ethernet]
? (192.168.1.255) at ff:ff:ff:ff:ff:ff on en0
`;
  assert.deepEqual(parseArpTable(output), [
    { ip: '192.168.1.20', mac: 'AA:BB:CC:DD:EE:FF', interfaceName: 'en0' },
    { ip: '192.168.1.30', mac: '00:90:E8:12:34:56', interfaceName: null },
    { ip: '192.168.127.250', mac: '00:90:E8:BC:A4:A0', interfaceName: 'en11' },
  ]);
});

test('discovery merges ARP entries with open ports without duplicates', () => {
  const open = new Map([
    ['en11:192.168.127.250', { interfaceName: 'en11', ip: '192.168.127.250' }],
    ['Ethernet:192.168.1.30', { interfaceName: 'Ethernet', ip: '192.168.1.30' }],
    ['routed:10.0.0.5', { interfaceName: 'routed', ip: '10.0.0.5' }],
    ['en0:192.168.1.40', { interfaceName: 'en0', ip: '192.168.1.40' }],
  ]);
  const arp = [
    { ip: '10.0.0.5', mac: '00:90:E8:00:00:05', interfaceName: 'en5' },
    { ip: '192.168.1.20', mac: 'AA:BB:CC:DD:EE:FF', interfaceName: 'en0' },
    { ip: '192.168.1.30', mac: '00:90:E8:12:34:56', interfaceName: null },
    { ip: '192.168.1.50', mac: '00:90:E8:00:00:50', interfaceName: null },
    { ip: '192.168.127.250', mac: '00:90:E8:BC:A4:A0', interfaceName: 'en11' },
  ];
  assert.deepEqual(mergeDiscoveryResults(arp, open), [
    { ip: '10.0.0.5', mac: '00:90:E8:00:00:05', interfaceName: 'en5', modbusOpen: true, vendor: 'Moxa' },
    { ip: '192.168.1.30', mac: '00:90:E8:12:34:56', interfaceName: 'Ethernet', modbusOpen: true, vendor: 'Moxa' },
    { ip: '192.168.1.40', mac: 'Unknown', interfaceName: 'en0', modbusOpen: true, vendor: null },
    { ip: '192.168.127.250', mac: '00:90:E8:BC:A4:A0', interfaceName: 'en11', modbusOpen: true, vendor: 'Moxa' },
    { ip: '192.168.1.50', mac: '00:90:E8:00:00:50', interfaceName: null, modbusOpen: false, vendor: 'Moxa' },
  ]);
});

test('subnet discovery only scans active /24 IPv4 interfaces', () => {
  assert.deepEqual(active24Networks({
    en11: [{ family: 'IPv4', internal: false, address: '192.168.127.240', netmask: '255.255.255.0' }],
    en0: [{ family: 'IPv4', internal: false, address: '192.168.201.111', netmask: '255.255.254.0' }],
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
  }), [{ interfaceName: 'en11', localAddress: '192.168.127.240', prefix: '192.168.127' }]);
});

test('targeted discovery only accepts complete IPv4 addresses', () => {
  assert.equal(validIPv4('192.168.127.254'), true);
  assert.equal(validIPv4('192.168.127.999'), false);
  assert.equal(validIPv4('192.168.127'), false);
  assert.equal(validIPv4('moxa.local'), false);
});

test('a polling failure makes data stale and locks the device offline', async () => {
  let reads = 0;
  const client = {
    setID() {},
    setTimeout() {},
    async connectTCP() {},
    destroy() {},
  };
  const manager = new ConnectionManager({
    id: 'test',
    label: 'Test',
    createClient: () => client,
    readSnapshot: async () => {
      reads += 1;
      if (reads === 1) return { value: 42 };
      throw new Error('Timed out');
    },
    runCommand: async () => {},
    pollIntervalMs: 10,
    random: () => 0,
  });
  manager.configure({ ip: '192.0.2.1', port: 502, unitId: 1, autoReconnect: false });
  await manager.connect();
  assert.equal(manager.snapshot().status, 'online');
  assert.deepEqual(manager.snapshot().telemetry, { value: 42 });

  while (manager.snapshot().status !== 'offline') await once(manager, 'state');
  assert.equal(manager.snapshot().stale, true);
  assert.equal(manager.snapshot().lastError, 'Timed out');
  await assert.rejects(() => manager.command('unsafe'), /not online/i);
  await manager.disconnect();
});

test('a model mismatch is non-retryable and preserves detected identity', async () => {
  const client = {
    setID() {},
    setTimeout() {},
    async connectTCP() {},
    destroy() {},
  };
  const manager = new ConnectionManager({
    id: 'windmill',
    label: 'Windmill',
    createClient: () => client,
    validateClient: async () => {
      const identity = { model: 'E1214', expectedModel: 'E1241', valid: false };
      const error = new Error('Wrong Moxa model: found E1214, expected E1241');
      error.retryable = false;
      error.identity = identity;
      throw error;
    },
    readSnapshot: async () => ({ value: 1 }),
    runCommand: async () => {},
    random: () => 0,
  });
  manager.configure({ ip: '192.0.2.10', port: 502, unitId: 1, autoReconnect: true });
  await manager.connect();
  assert.equal(manager.snapshot().status, 'offline');
  assert.equal(manager.snapshot().nextRetryAt, null);
  assert.equal(manager.snapshot().identity.model, 'E1214');
  assert.match(manager.snapshot().lastError, /expected E1241/);
  await manager.disconnect();
});

test('automatic reconnect can be disabled without disconnecting configuration', async () => {
  const manager = new ConnectionManager({
    id: 'test',
    label: 'Test',
    createClient: () => ({
      setID() {},
      setTimeout() {},
      async connectTCP() { throw new Error('Cable unplugged'); },
      destroy() {},
    }),
    readSnapshot: async () => ({}),
    runCommand: async () => {},
    random: () => 0,
  });
  manager.configure({ ip: '192.0.2.10', port: 502, unitId: 1, autoReconnect: true });
  await manager.connect();
  assert.equal(manager.snapshot().status, 'reconnecting');
  assert.notEqual(manager.snapshot().nextRetryAt, null);

  const disabled = manager.setAutoReconnect(false);
  assert.equal(disabled.config.autoReconnect, false);
  assert.equal(disabled.status, 'offline');
  assert.equal(disabled.nextRetryAt, null);
  await manager.disconnect();
});
