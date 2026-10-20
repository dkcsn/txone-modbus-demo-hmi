function wordToAscii(word) {
  return String.fromCharCode((word >> 8) & 0xff, word & 0xff);
}

function wordsToAscii(words) {
  return words.map(wordToAscii).join('').replace(/\0/g, '').trim();
}

function formatMac(words) {
  return words
    .flatMap((word) => [(word >> 8) & 0xff, word & 0xff])
    .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

function wordsToBytes(words) {
  return words.flatMap((word) => [(word >> 8) & 0xff, word & 0xff]);
}

function formatFirmware(words) {
  const bytes = wordsToBytes(words).slice(0, 3);
  return bytes.length ? `v${bytes.join('.')}` : 'Unknown';
}

function normaliseModel(model) {
  return String(model || '').replace(/^ioLogik\s+/i, '').trim().toUpperCase();
}

function modelMatches(model, acceptedModels) {
  const actual = normaliseModel(model);
  return acceptedModels.some((accepted) => actual === normaliseModel(accepted));
}

async function readMoxaIdentity(client) {
  const model = await client.readInputRegisters(5000, 10);
  const mac = await client.readInputRegisters(5024, 3);
  const firmware = await client.readInputRegisters(5029, 2);
  const name = await client.readInputRegisters(5040, 30);
  return {
    model: wordsToAscii(model.data),
    mac: formatMac(mac.data),
    firmware: formatFirmware(firmware.data),
    deviceName: wordsToAscii(name.data),
  };
}

function createModelValidator(expectedModel, acceptedModels) {
  return async (client) => {
    const identity = await readMoxaIdentity(client);
    const valid = modelMatches(identity.model, acceptedModels);
    const result = { ...identity, expectedModel, valid };
    if (!valid) {
      const error = new Error(`Wrong Moxa model: found ${identity.model || 'unknown'}, expected ${expectedModel}`);
      error.retryable = false;
      error.identity = result;
      throw error;
    }
    return result;
  };
}

function parseFanCoils(coils) {
  const running = Boolean(coils[0]);
  if (!running) return { mode: 'off', running: false, speed: 0 };
  const highSpeed = !Boolean(coils[1]);
  return { mode: highSpeed ? 'high' : 'low', running: true, speed: highSpeed ? 100 : 55 };
}

const fanProfile = {
  id: 'fan',
  label: 'CPU Fan',
  expectedModel: 'E1214',
  acceptedModels: ['E1214', 'E1214-T'],
  readIdentity: readMoxaIdentity,
  validateClient: createModelValidator('E1214', ['E1214', 'E1214-T']),
  async readSnapshot(client) {
    const result = await client.readCoils(0, 2);
    return parseFanCoils(result.data);
  },
  async runCommand(client, name) {
    if (name === 'fan-off') {
      await client.writeCoil(0, false);
      await client.writeCoil(1, false);
      return;
    }
    if (name === 'fan-low') {
      await client.writeCoil(0, true);
      await client.writeCoil(1, true);
      return;
    }
    if (name === 'fan-high') {
      await client.writeCoil(0, true);
      await client.writeCoil(1, false);
      return;
    }
    throw new Error(`Unsupported fan command: ${name}`);
  },
};

function indicatorForValue(value) {
  if (value < 600) return 0;
  if (value < 2_600) return 820;
  if (value < 3_100) return 3_277;
  if (value < 4_095) return 3_769;
  return 4_096;
}

const WINDMILL_MAX_OUTPUT = 3_072;
const WINDMILL_NOMINAL_RPM = 30;

function parseWindmillRegisters(registers) {
  const [rawSpeed = 0, enableOutput = 0, indicatorOutput = 0] = registers;
  return {
    rawSpeed,
    rpm: Number(((rawSpeed / WINDMILL_MAX_OUTPUT) * WINDMILL_NOMINAL_RPM).toFixed(1)),
    percent: Math.round((rawSpeed / WINDMILL_MAX_OUTPUT) * 100),
    outputVolts: Number(((rawSpeed / 4_096) * 10).toFixed(2)),
    enableOutput,
    indicatorOutput,
    emergencyStopActive: enableOutput < 4_000,
  };
}

const windmillProfile = {
  id: 'windmill',
  label: 'Windmill',
  expectedModel: 'E1241',
  acceptedModels: ['E1241', 'E1241-T'],
  readIdentity: readMoxaIdentity,
  validateClient: createModelValidator('E1241', ['E1241', 'E1241-T']),
  async readSnapshot(client) {
    const result = await client.readHoldingRegisters(1024, 3);
    return parseWindmillRegisters(result.data);
  },
  async runCommand(client, name, payload = {}) {
    if (name === 'windmill-speed') {
      const requested = Number(payload.value);
      if (!Number.isFinite(requested)) throw new Error('Speed must be a number');
      const clean = Math.max(0, Math.min(WINDMILL_MAX_OUTPUT, Math.round(requested)));
      await client.writeRegister(1024, clean);
      await client.writeRegister(1026, indicatorForValue(clean));
      return;
    }
    if (name === 'windmill-stop') {
      await client.writeRegister(1024, 0);
      await client.writeRegister(1025, 0);
      return;
    }
    if (name === 'windmill-restart') {
      await client.writeRegister(1024, 0);
      await client.writeRegister(1025, 4_095);
      return;
    }
    throw new Error(`Unsupported windmill command: ${name}`);
  },
};

module.exports = {
  fanProfile,
  windmillProfile,
  parseFanCoils,
  indicatorForValue,
  WINDMILL_MAX_OUTPUT,
  WINDMILL_NOMINAL_RPM,
  parseWindmillRegisters,
  wordsToAscii,
  formatMac,
  formatFirmware,
  normaliseModel,
  modelMatches,
  readMoxaIdentity,
};
