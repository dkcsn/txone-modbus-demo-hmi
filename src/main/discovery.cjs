const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const net = require('node:net');
const os = require('node:os');

const execFileAsync = promisify(execFile);

function parseArpTable(output) {
  const found = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const ip = line.match(/(?:\(|\s|^)((?:\d{1,3}\.){3}\d{1,3})(?:\)|\s|$)/)?.[1];
    const mac = line.match(/\b(?:[0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}\b/i)?.[0];
    if (!ip || !mac) continue;
    const normalisedMac = mac
      .split(/[:-]/)
      .map((part) => part.padStart(2, '0'))
      .join(':')
      .toUpperCase();
    if (normalisedMac === 'FF:FF:FF:FF:FF:FF') continue;
    const interfaceName = line.match(/\son\s+(\S+)/)?.[1] || null;
    found.set(`${interfaceName || ''}:${ip}`, { ip, mac: normalisedMac, interfaceName });
  }
  return [...found.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

function probePort(ip, port, timeoutMs = 350, localAddress) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    const options = { port, host: ip };
    if (localAddress) options.localAddress = localAddress;
    socket.connect(options);
  });
}

function active24Networks(networkInterfaces = os.networkInterfaces()) {
  const networks = [];
  for (const [interfaceName, addresses] of Object.entries(networkInterfaces)) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal || address.netmask !== '255.255.255.0') continue;
      const octets = address.address.split('.').map(Number);
      if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) continue;
      networks.push({
        interfaceName,
        localAddress: address.address,
        prefix: `${octets[0]}.${octets[1]}.${octets[2]}`,
      });
    }
  }
  return networks;
}

async function readArpTable() {
  const executable = process.platform === 'darwin' ? '/usr/sbin/arp' : 'arp.exe';
  const args = process.platform === 'darwin' ? ['-an'] : ['-a'];
  const { stdout } = await execFileAsync(executable, args, { timeout: 5_000, maxBuffer: 1024 * 1024 });
  return parseArpTable(stdout);
}

function validIPv4(value) {
  const parts = String(value || '').trim().split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

async function discoverArpDevices(port = 502, targetIps = []) {
  const networks = active24Networks();
  const queue = networks.flatMap((network) =>
    Array.from({ length: 254 }, (_, index) => ({
      ...network,
      ip: `${network.prefix}.${index + 1}`,
    })).filter((candidate) => candidate.ip !== network.localAddress),
  );
  const queuedIps = new Set(queue.map((candidate) => candidate.ip));
  for (const ip of [...new Set(targetIps.map((value) => String(value || '').trim()))]) {
    if (!validIPv4(ip) || queuedIps.has(ip)) continue;
    queue.push({ interfaceName: 'routed', localAddress: null, prefix: null, ip });
    queuedIps.add(ip);
  }
  const open = new Map();

  async function worker() {
    while (queue.length) {
      const candidate = queue.shift();
      if (await probePort(candidate.ip, port, 450, candidate.localAddress)) {
        open.set(`${candidate.interfaceName}:${candidate.ip}`, candidate);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(48, queue.length) }, () => worker()));
  return mergeDiscoveryResults(await readArpTable(), open);
}

function findOpenCandidate(device, open, matched) {
  const exactKey = `${device.interfaceName || ''}:${device.ip}`;
  if (open.has(exactKey)) return exactKey;
  // Windows ARP output has no interface name, and targeted probes are keyed as "routed",
  // so fall back to matching on IP alone for those cases.
  for (const [key, candidate] of open) {
    if (matched.has(key) || candidate.ip !== device.ip) continue;
    if (!device.interfaceName || candidate.interfaceName === 'routed') return key;
  }
  return null;
}

function mergeDiscoveryResults(arpDevices, open) {
  const results = new Map();
  const matched = new Set();

  for (const device of arpDevices) {
    const openKey = findOpenCandidate(device, open, matched);
    const isMoxa = device.mac.startsWith('00:90:E8:');
    if (!openKey && !isMoxa) continue;
    if (openKey) matched.add(openKey);
    const interfaceName = device.interfaceName || open.get(openKey)?.interfaceName || null;
    results.set(openKey || `${device.interfaceName || ''}:${device.ip}`, {
      ...device,
      interfaceName,
      modbusOpen: Boolean(openKey),
      vendor: isMoxa ? 'Moxa' : null,
    });
  }
  for (const [key, candidate] of open) {
    if (!matched.has(key)) {
      results.set(key, { ip: candidate.ip, mac: 'Unknown', interfaceName: candidate.interfaceName, modbusOpen: true, vendor: null });
    }
  }

  return [...results.values()].sort((a, b) => Number(b.modbusOpen) - Number(a.modbusOpen) || a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

module.exports = { discoverArpDevices, mergeDiscoveryResults, parseArpTable, probePort, active24Networks, validIPv4 };
