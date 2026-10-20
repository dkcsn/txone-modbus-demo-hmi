const { EventEmitter } = require('node:events');

const CONNECTION_STATES = new Set([
  'disconnected',
  'connecting',
  'online',
  'reconnecting',
  'offline',
]);

function normaliseError(error) {
  if (!error) return 'Unknown communication error';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

function reconnectDelay(attempt, random = Math.random) {
  const base = Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.round(base * 0.2 * random());
  return base + jitter;
}

class ConnectionManager extends EventEmitter {
  constructor(options) {
    super();
    this.id = options.id;
    this.label = options.label;
    this.createClient = options.createClient;
    this.readSnapshot = options.readSnapshot;
    this.validateClient = options.validateClient || (async () => null);
    this.runCommand = options.runCommand;
    this.log = options.log || (() => {});
    this.pollIntervalMs = options.pollIntervalMs || 1_000;
    this.connectTimeoutMs = options.connectTimeoutMs || 900;
    this.requestTimeoutMs = options.requestTimeoutMs || 750;
    this.random = options.random || Math.random;
    this.clock = options.clock || (() => Date.now());

    this.client = null;
    this.config = { ip: '', port: 502, unitId: 1, autoReconnect: true };
    this.timer = null;
    this.generation = 0;
    this.connectPromise = null;
    this.operation = Promise.resolve();
    this.manualDisconnect = true;
    this.disposed = false;
    this.state = {
      id: this.id,
      label: this.label,
      status: 'disconnected',
      attempt: 0,
      telemetry: null,
      stale: true,
      lastUpdatedAt: null,
      lastError: null,
      nextRetryAt: null,
      identity: null,
      validatedAt: null,
    };
  }

  snapshot() {
    return { ...this.state, config: { ...this.config } };
  }

  configure(next) {
    const port = Number(next.port);
    const unitId = Number(next.unitId ?? 1);
    if (typeof next.ip !== 'string') throw new Error('IP address must be text');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
    if (!Number.isInteger(unitId) || unitId < 1 || unitId > 247) throw new Error('Unit ID must be 1–247');
    const previousEndpoint = `${this.config.ip}:${this.config.port}:${this.config.unitId}`;
    this.config = {
      ip: next.ip.trim(),
      port,
      unitId,
      autoReconnect: next.autoReconnect !== false,
    };
    const nextEndpoint = `${this.config.ip}:${this.config.port}:${this.config.unitId}`;
    if (previousEndpoint !== nextEndpoint) {
      this.state.identity = null;
      this.state.validatedAt = null;
    }
    this._emit();
  }

  setAutoReconnect(enabled) {
    this.config.autoReconnect = Boolean(enabled);
    if (!this.config.autoReconnect && ['reconnecting', 'offline'].includes(this.state.status)) {
      this._clearTimer();
      this._setState({ status: 'offline', nextRetryAt: null });
    } else {
      this._emit();
    }
    return this.snapshot();
  }

  async connect() {
    if (this.disposed) throw new Error('Connection manager has been disposed');
    if (!this.config.ip) throw new Error('Configure an IP address before connecting');
    if (this.connectPromise) return this.connectPromise;

    this.manualDisconnect = false;
    this._clearTimer();
    const generation = ++this.generation;
    this.connectPromise = this._open(generation).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async _open(generation) {
    this._setState({
      status: this.state.attempt ? 'reconnecting' : 'connecting',
      stale: true,
      nextRetryAt: null,
    });

    const client = this.createClient();
    try {
      client.setID?.(this.config.unitId);
      client.setTimeout?.(this.requestTimeoutMs);
      await client.connectTCP(this.config.ip, {
        port: this.config.port,
        timeout: this.connectTimeoutMs,
      });
      if (generation !== this.generation || this.manualDisconnect || this.disposed) {
        this._destroyClient(client);
        return this.snapshot();
      }

      this._destroyClient(this.client);
      this.client = client;
      const identity = await this._serial(() => this.validateClient(client));
      const telemetry = await this._serial(() => this.readSnapshot(client));
      this._setState({
        status: 'online',
        attempt: 0,
        telemetry,
        stale: false,
        lastUpdatedAt: this.clock(),
        lastError: null,
        nextRetryAt: null,
        identity,
        validatedAt: identity ? this.clock() : null,
      });
      this.log('info', this.id, `Connected to ${this.config.ip}:${this.config.port}`);
      this._schedulePoll(generation);
      return this.snapshot();
    } catch (error) {
      this._destroyClient(client);
      if (generation === this.generation && !this.manualDisconnect && !this.disposed) {
        this._connectionFailed(error, generation);
      }
      return this.snapshot();
    }
  }

  async disconnect() {
    this.manualDisconnect = true;
    this.generation += 1;
    this._clearTimer();
    this._destroyClient(this.client);
    this.client = null;
    this._setState({
      status: 'disconnected',
      attempt: 0,
      stale: true,
      lastError: null,
      nextRetryAt: null,
    });
    this.log('info', this.id, 'Disconnected by operator');
    return this.snapshot();
  }

  async retryNow() {
    if (this.manualDisconnect) this.manualDisconnect = false;
    this.state.attempt = 0;
    return this.connect();
  }

  async command(name, payload) {
    if (this.state.status !== 'online' || !this.client || this.state.stale) {
      throw new Error('Device is not online. No command was sent.');
    }
    const generation = this.generation;
    try {
      const result = await this._serial(async () => {
        await this.runCommand(this.client, name, payload);
        return this.readSnapshot(this.client);
      });
      if (generation === this.generation) {
        this._setState({
          status: 'online',
          telemetry: result,
          stale: false,
          lastUpdatedAt: this.clock(),
          lastError: null,
        });
      }
      this.log('info', this.id, `Command completed: ${name}`);
      return this.snapshot();
    } catch (error) {
      if (generation === this.generation) this._connectionFailed(error, generation);
      throw new Error(`Command failed: ${normaliseError(error)}`);
    }
  }

  async dispose() {
    this.disposed = true;
    await this.disconnect();
    this.removeAllListeners();
  }

  _schedulePoll(generation, delay = this.pollIntervalMs) {
    this._clearTimer();
    this.timer = setTimeout(async () => {
      if (generation !== this.generation || this.manualDisconnect || this.disposed) return;
      try {
        const telemetry = await this._serial(() => this.readSnapshot(this.client));
        if (generation !== this.generation) return;
        this._setState({
          status: 'online',
          attempt: 0,
          telemetry,
          stale: false,
          lastUpdatedAt: this.clock(),
          lastError: null,
          nextRetryAt: null,
        });
        this._schedulePoll(generation);
      } catch (error) {
        if (generation === this.generation) this._connectionFailed(error, generation);
      }
    }, delay);
  }

  _connectionFailed(error, generation) {
    const message = normaliseError(error);
    this._destroyClient(this.client);
    this.client = null;
    const attempt = this.state.attempt + 1;
    const shouldRetry = error?.retryable !== false && this.config.autoReconnect && !this.manualDisconnect && !this.disposed;
    const delay = reconnectDelay(attempt, this.random);
    this._setState({
      status: shouldRetry ? (attempt >= 3 ? 'offline' : 'reconnecting') : 'offline',
      attempt,
      stale: true,
      lastError: message,
      nextRetryAt: shouldRetry ? this.clock() + delay : null,
      ...(error?.identity ? { identity: error.identity, validatedAt: null } : {}),
    });
    this.log('warn', this.id, `Connection lost: ${message}`);
    if (!shouldRetry) return;
    this._clearTimer();
    this.timer = setTimeout(() => {
      if (generation !== this.generation || this.manualDisconnect || this.disposed) return;
      this.connect();
    }, delay);
  }

  _serial(task) {
    const run = this.operation.then(task, task);
    this.operation = run.catch(() => {});
    return run;
  }

  _setState(patch) {
    if (patch.status && !CONNECTION_STATES.has(patch.status)) {
      throw new Error(`Invalid connection state: ${patch.status}`);
    }
    Object.assign(this.state, patch);
    this._emit();
  }

  _emit() {
    this.emit('state', this.snapshot());
  }

  _clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _destroyClient(client) {
    if (!client) return;
    try {
      client.destroy?.(() => {});
    } catch {
      try {
        client.close?.(() => {});
      } catch {}
    }
  }
}

module.exports = { ConnectionManager, reconnectDelay, normaliseError };
