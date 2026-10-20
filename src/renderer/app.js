const appRoot = document.querySelector('#app');
const toastRegion = document.querySelector('#toast-region');

const state = {
  activeDemo: null,
  view: 'control',
  devices: {},
  logs: [],
  version: '',
  draftSpeed: null,
  discovery: {},
  networks: [],
};

const speedControl = {
  timer: null,
  queuedValue: null,
  inFlight: false,
};

const SPEED_DEBOUNCE_MS = 200;
const WINDMILL_MAX_OUTPUT = 3_072;
const WINDMILL_NOMINAL_RPM = 30;
const WINDMILL_GAUGE_MAX_RPM = 40;

const demoSetup = {
  fan: {
    expectedModel: 'E1214',
    purpose: 'Six digital inputs and six relays for fan power and PWM selection.',
    readTest: 'Read coils 0–1',
    checkpoints: [
      'Use a four-wire 12 V PWM fan. The guide notes that a three-wire fan is not suitable.',
      'Verify the 12 V supply polarity before connecting the ioLogik and fan.',
      'Check the R0 and R1 relay wiring against the assembly guide before sending a command.',
    ],
  },
  windmill: {
    expectedModel: 'E1241',
    purpose: 'Four analogue outputs for the 0–10 V turbine speed signal.',
    readTest: 'Read AO0 at holding register 1024',
    checkpoints: [
      'The E1241 AO0 output feeds the EM-323 controller; it does not power the LEGO motor directly.',
      'Confirm a common 0 V reference between the E1241, EM-323 and the 12 V to 9 V converter.',
      'EM-323 guide values: P1 1, P2 1, P3 10, P4 10, P5 20, P6 0, P7 38, P8 90.',
    ],
  },
};

const labels = {
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  online: 'Online',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTime(timestamp) {
  if (!timestamp) return 'Never';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp);
}

function formatDateTime(timestamp) {
  if (!timestamp) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(timestamp);
}

function statusPill(device) {
  const status = device?.status || 'disconnected';
  return `<span class="status-pill status-${status}"><span class="status-dot"></span>${labels[status]}</span>`;
}

function toast(title, message, type = 'info') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span>`;
  toastRegion.append(element);
  setTimeout(() => element.remove(), 4_500);
}

function selectionView() {
  return `
    <div class="selection-shell">
      <header class="brand-bar">
        <img class="brand-logo" src="assets/txone.png" alt="TXOne Networks" />
        <span class="brand-divider"></span>
        <span class="brand-title">Modbus Demo HMI</span>
      </header>
      <main class="chooser">
        <div class="eyebrow">Industrial control demonstrations</div>
        <h1>Choose a demo</h1>
        <p class="lead">Select the system you want to operate. Only the active demo can open a Modbus connection or send commands.</p>
        <div class="demo-grid">
          <button class="demo-card" data-select-demo="fan">
            <span class="demo-icon-wrap"><img class="demo-icon" src="assets/fan.svg" alt="" /></span>
            <h2>CPU Fan</h2>
            <p>Start and stop the fan, select its operating speed, and monitor the live coil state.</p>
            <span class="demo-arrow">→</span>
          </button>
          <button class="demo-card" data-select-demo="windmill">
            <span class="demo-icon-wrap"><img class="demo-icon" src="assets/mill.svg" alt="" /></span>
            <h2>Windmill</h2>
            <p>Control the drive speed, monitor RPM and PLC identity, and operate the emergency stop.</p>
            <span class="demo-arrow">→</span>
          </button>
        </div>
      </main>
      <footer class="selection-footer">by Christian Søgaard Nielsen 2026</footer>
    </div>`;
}

function shell(content, device) {
  const title = state.activeDemo === 'fan' ? 'CPU Fan HMI' : 'Windmill HMI';
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="sidebar-brand"><img src="assets/txone.png" alt="TXOne Networks" /></div>
        <nav class="nav" aria-label="Main navigation">
          <button class="nav-button ${state.view === 'control' ? 'active' : ''}" data-view="control"><span class="nav-icon">◉</span>Control</button>
          <button class="nav-button ${state.view === 'diagnostics' ? 'active' : ''}" data-view="diagnostics"><span class="nav-icon">≡</span>Diagnostics</button>
          <button class="nav-button ${state.view === 'help' ? 'active' : ''}" data-view="help"><span class="nav-icon">?</span>Setup help</button>
          <button class="nav-button" data-select-demo=""><span class="nav-icon">⌘</span>Change demo</button>
        </nav>
        <div class="sidebar-footer">TXOne Modbus Demo HMI · Version ${escapeHtml(state.version)}<br /><span>by Christian Søgaard Nielsen 2026</span></div>
      </aside>
      <section class="workspace">
        <header class="topbar">
          <div class="topbar-title">${title}</div>
          <div class="topbar-meta">
            <span data-last-data>Last data: ${formatTime(device?.lastUpdatedAt)}</span>
            ${statusPill(device)}
          </div>
        </header>
        <main class="main">${content}</main>
      </section>
    </div>`;
}

function connectionPanel(id, device) {
  const config = device.config || {};
  const requirement = demoSetup[id];
  const active = device.status === 'online' || device.status === 'connecting' || device.status === 'reconnecting' || device.status === 'offline';
  const discovery = state.discovery[id];
  const results = Array.isArray(discovery) ? discovery.map((item) => {
    const verification = item.verification || 'unverified';
    const label = verification === 'match'
      ? `${item.model} verified`
      : verification === 'wrong-model'
        ? `${item.model || 'Unknown'} · expected ${item.expectedModel}`
        : verification === 'unreachable' ? 'Moxa found · Modbus closed' : 'Identity not verified';
    const canUse = verification === 'match';
    const identityLine = item.model
      ? `Moxa ioLogik ${item.model} · ${item.firmware || 'firmware unknown'} · ${item.mac}`
      : `${item.vendor ? `${item.vendor} · ` : ''}${item.mac}`;
    return `
    <div class="discovery-result">
      <div><strong>${escapeHtml(item.ip)}</strong><small>${escapeHtml(identityLine)}${item.interfaceName ? ` · ${escapeHtml(item.interfaceName)}` : ''}</small></div>
      <span class="discovery-verification verification-${escapeHtml(verification)}">${escapeHtml(label)}</span>
      <button class="button button-quiet" type="button" data-use-ip="${escapeHtml(item.ip)}" ${canUse ? '' : 'disabled'}>${canUse ? 'Use' : 'Blocked'}</button>
    </div>`;
  }).join('') : '';
  const identity = device.identity;
  return `
    <section class="panel">
      <div class="panel-header"><div><h3>Connection settings</h3><p>Requires Moxa ioLogik ${requirement.expectedModel}; identity is checked before controls unlock.</p></div>${statusPill(device)}</div>
      <div class="panel-body">
        ${identity ? `<div class="identity-banner ${identity.valid ? 'identity-valid' : 'identity-invalid'}"><strong>${identity.valid ? 'Verified device' : 'Wrong device'}</strong><span>${escapeHtml(identity.model || 'Unknown model')} · ${escapeHtml(identity.firmware || 'Unknown firmware')} · ${escapeHtml(identity.mac || 'Unknown MAC')}</span></div>` : ''}
        <form id="connection-form" data-device="${id}">
          <div class="connection-grid">
            <label>IP address<input name="ip" type="text" inputmode="decimal" placeholder="192.168.1.10" value="${escapeHtml(config.ip)}" ${active ? 'disabled' : ''} required /></label>
            <label>Port<input name="port" type="number" min="1" max="65535" value="${escapeHtml(config.port || 502)}" ${active ? 'disabled' : ''} required /></label>
            <label>Unit ID<input name="unitId" type="number" min="1" max="247" value="${escapeHtml(config.unitId || 1)}" ${active ? 'disabled' : ''} required /></label>
          </div>
          <label class="checkbox-row"><input name="autoReconnect" type="checkbox" data-auto-reconnect="${id}" ${config.autoReconnect !== false ? 'checked' : ''} /> Reconnect automatically after a network interruption</label>
          <div class="actions">
            ${active
              ? `<button class="button" type="button" data-disconnect="${id}">Disconnect</button>${device.status !== 'online' ? `<button class="button button-primary" type="button" data-retry="${id}">Retry now</button>` : ''}`
              : `<button class="button button-primary" type="submit">Save and connect</button><button class="button" type="button" data-discover="${id}">${discovery === 'loading' ? 'Searching…' : 'Find Moxa'}</button>`}
          </div>
          ${!active && discovery !== 'loading' && Array.isArray(discovery) ? `<div class="discovery-list">${results || '<div class="empty-state">No Modbus candidates were found on an active /24 network.</div>'}</div>` : ''}
        </form>
      </div>
    </section>`;
}

function networkAlert(device) {
  if (!device || ['online', 'disconnected', 'connecting'].includes(device.status)) return '';
  const retry = device.nextRetryAt ? ` Automatic retry in ${Math.max(0, Math.ceil((device.nextRetryAt - Date.now()) / 1000))} s.` : '';
  return `<div class="alert-strip"><div><strong>Connection interrupted.</strong> Displayed values are the last verified data and controls are locked.${retry}<br /><small>${escapeHtml(device.lastError || '')}</small></div></div>`;
}

function fanControl(device) {
  const telemetry = device.telemetry || { mode: 'off', speed: 0 };
  const online = device.status === 'online' && !device.stale;
  const animation = telemetry.mode === 'high' ? 'fan-spinning-high' : telemetry.mode === 'low' ? 'fan-spinning-low' : '';
  return `
    <div class="page-heading"><div><h2>Fan control</h2><p>Direct control and live state from coils 0–1.</p></div></div>
    ${networkAlert(device)}
    <div class="grid grid-2">
      <div class="stack">
        <section class="panel">
          <div class="panel-header"><div><h3>Live fan status</h3><p>${device.stale ? 'Last verified state' : 'Updated once per second'}</p></div></div>
          <div class="machine-stage ${device.stale ? 'stale' : ''}">
            <img class="fan-visual ${animation}" src="assets/fan.svg" alt="Fan status illustration" />
            <div class="machine-caption"><strong>${telemetry.mode === 'off' ? 'Fan stopped' : `${telemetry.mode === 'high' ? 'High' : 'Low'} speed`}</strong>${device.stale ? 'Waiting for verified data' : `${telemetry.speed}% command state`}</div>
          </div>
        </section>
        <div class="metric-row">
          <div class="metric"><div class="metric-label">Operating state</div><div class="metric-value">${escapeHtml(telemetry.mode).toUpperCase()}</div></div>
          <div class="metric"><div class="metric-label">Command level</div><div class="metric-value">${telemetry.speed}<span class="metric-unit"> %</span></div></div>
          <div class="metric"><div class="metric-label">Data age</div><div class="metric-value">${device.lastUpdatedAt ? Math.max(0, Math.floor((Date.now() - device.lastUpdatedAt) / 1000)) : '—'}<span class="metric-unit"> s</span></div></div>
        </div>
      </div>
      <div class="stack">
        <section class="panel">
          <div class="panel-header"><div><h3>Fan command</h3><p>Commands are disabled unless the link is verified online.</p></div></div>
          <div class="panel-body">
            <div class="segmented">
              <button class="button ${telemetry.mode === 'off' ? 'active' : ''}" data-command="fan-off" ${online ? '' : 'disabled'}>Off</button>
              <button class="button ${telemetry.mode === 'low' ? 'active' : ''}" data-command="fan-low" ${online ? '' : 'disabled'}>Low</button>
              <button class="button ${telemetry.mode === 'high' ? 'active' : ''}" data-command="fan-high" ${online ? '' : 'disabled'}>High</button>
            </div>
          </div>
        </section>
        ${connectionPanel('fan', device)}
      </div>
    </div>`;
}

function windmillVisual(telemetry, stale) {
  return `
    <svg class="windmill-scene ${stale ? 'is-stale' : ''}" viewBox="0 -70 520 490" role="img" aria-label="LEGO-inspired wind turbine showing ${telemetry.rpm} revolutions per minute">
      <defs>
        <linearGradient id="tower-face" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#bfc4c8" />
          <stop offset=".42" stop-color="#f5f6f6" />
          <stop offset="1" stop-color="#a8adb2" />
        </linearGradient>
        <linearGradient id="blade-face" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffffff" />
          <stop offset="1" stop-color="#c7cbcf" />
        </linearGradient>
        <filter id="scene-shadow" x="-30%" y="-30%" width="160%" height="180%">
          <feDropShadow dx="0" dy="10" stdDeviation="8" flood-color="#000" flood-opacity=".3" />
        </filter>
      </defs>
      <g transform="translate(0 45)">
      <ellipse cx="260" cy="341" rx="142" ry="18" fill="#151516" opacity=".55" />
      <g filter="url(#scene-shadow)">
        <path d="M214 326 L235 116 L285 116 L306 326 Z" fill="url(#tower-face)" stroke="#8f9498" stroke-width="3" />
        <g class="lego-seams" stroke="#8f9498" stroke-width="2" opacity=".72">
          <path d="M231 157H289M227 199H293M223 241H297M219 283H301" />
          <path d="M260 158V198M248 200V240M273 242V282M244 284V325" />
        </g>
        <path d="M197 319H323V342H197Z" fill="#5c6267" stroke="#8a9095" stroke-width="3" />
        <path d="M179 338H341V354H179Z" fill="#2d9b58" stroke="#237a46" stroke-width="3" />
        <g fill="#55bd73" stroke="#237a46" stroke-width="1.5">
          <ellipse cx="196" cy="338" rx="9" ry="4" /><ellipse cx="228" cy="338" rx="9" ry="4" />
          <ellipse cx="260" cy="338" rx="9" ry="4" /><ellipse cx="292" cy="338" rx="9" ry="4" />
          <ellipse cx="324" cy="338" rx="9" ry="4" />
        </g>
        <path d="M225 92 Q225 79 239 77 H302 Q318 78 320 91 V119 H225Z" fill="#e8e9ea" stroke="#92979b" stroke-width="3" />
        <path d="M295 83H319V112H295Z" fill="#e52630" opacity=".92" />
        <circle cx="304" cy="97" r="5" fill="#ff6970" />
      </g>
      <g transform="translate(260 100) scale(2.1) translate(-260 -100)">
      <g class="windmill-rotor">
        <g class="windmill-blade">
          <path d="M249 95 L247 7 Q252 -2 260 4 L269 93Z" fill="url(#blade-face)" stroke="#979ca1" stroke-width="2" />
          <g fill="#eef0f1" stroke="#a8adb1" stroke-width="1"><circle cx="254" cy="24" r="3.5"/><circle cx="256" cy="45" r="3.5"/><circle cx="258" cy="66" r="3.5"/></g>
        </g>
        <g class="windmill-blade" transform="rotate(120 260 100)">
          <path d="M249 95 L247 7 Q252 -2 260 4 L269 93Z" fill="url(#blade-face)" stroke="#979ca1" stroke-width="2" />
          <g fill="#eef0f1" stroke="#a8adb1" stroke-width="1"><circle cx="254" cy="24" r="3.5"/><circle cx="256" cy="45" r="3.5"/><circle cx="258" cy="66" r="3.5"/></g>
        </g>
        <g class="windmill-blade" transform="rotate(240 260 100)">
          <path d="M249 95 L247 7 Q252 -2 260 4 L269 93Z" fill="url(#blade-face)" stroke="#979ca1" stroke-width="2" />
          <g fill="#eef0f1" stroke="#a8adb1" stroke-width="1"><circle cx="254" cy="24" r="3.5"/><circle cx="256" cy="45" r="3.5"/><circle cx="258" cy="66" r="3.5"/></g>
        </g>
      </g>
      </g>
      <circle cx="260" cy="100" r="19" fill="#d5d8da" stroke="#858b90" stroke-width="4" />
      <circle cx="260" cy="100" r="10" fill="#e52630" stroke="#a9161e" stroke-width="3" />
      <circle cx="257" cy="97" r="2.5" fill="#ff7a80" />
      </g>
    </svg>`;
}

function syncWindmillAnimation(scene, device) {
  if (!scene || !device) return;
  const rawSpeed = Number(device.telemetry?.rawSpeed || 0);
  const rpm = (rawSpeed / WINDMILL_MAX_OUTPUT) * WINDMILL_NOMINAL_RPM;
  const stopped = device.telemetry?.emergencyStopActive !== false;
  const shouldSpin = device.status === 'online' && !device.stale && !stopped && rpm > 0;
  scene.setAttribute('aria-label', `LEGO-inspired wind turbine showing ${rpm.toFixed(1)} revolutions per minute`);
  const rotor = scene.querySelector('.windmill-rotor');
  const animation = rotor?.getAnimations()[0];
  if (!animation) return;
  const nextRate = Math.max(.1, rpm);
  if (Math.abs(Number(rotor.dataset.playbackRate || 0) - nextRate) > .01) {
    animation.updatePlaybackRate(nextRate);
    rotor.dataset.playbackRate = String(nextRate);
  }
  if (shouldSpin && animation.playState !== 'running') animation.play();
  if (!shouldSpin && animation.playState !== 'paused') animation.pause();
}

function windmillStructureKey(device) {
  const telemetry = device?.telemetry || {};
  const identity = device?.identity || {};
  const config = device?.config || {};
  return JSON.stringify({
    status: device?.status,
    stale: device?.stale,
    emergencyStopActive: telemetry.emergencyStopActive,
    overspeed: Number(telemetry.rawSpeed || 0) > WINDMILL_MAX_OUTPUT,
    identity: [identity.model, identity.firmware, identity.mac, identity.valid],
    config: [config.ip, config.port, config.unitId, config.autoReconnect],
    lastError: device?.lastError,
    nextRetryAt: device?.nextRetryAt,
  });
}

function setText(selector, value) {
  const element = appRoot.querySelector(selector);
  if (element) element.textContent = value;
}

function updateWindmillLive(device) {
  const rawSpeed = Number(device.telemetry?.rawSpeed || 0);
  const rpm = Number(((rawSpeed / WINDMILL_MAX_OUTPUT) * WINDMILL_NOMINAL_RPM).toFixed(1));
  const percent = Math.round((rawSpeed / WINDMILL_MAX_OUTPUT) * 100);
  const volts = Number(((rawSpeed / 4_096) * 10).toFixed(2));
  const displayRpm = rpm.toFixed(1);

  setText('[data-last-data]', `Last data: ${formatTime(device.lastUpdatedAt)}`);
  setText('[data-windmill-rpm-caption]', `${displayRpm} rpm`);
  setText('[data-windmill-percent-caption]', `${percent}% of rated speed`);
  setText('[data-windmill-rpm-metric]', displayRpm);
  setText('[data-windmill-raw-metric]', String(rawSpeed));
  setText('[data-windmill-volts-metric]', volts.toFixed(2));
  setText('[data-gauge-rpm]', `${displayRpm} RPM`);
  setText('[data-gauge-detail]', `${percent}% demo speed · ${volts.toFixed(2)} V · raw ${rawSpeed}`);

  const gauge = appRoot.querySelector('.output-gauge svg');
  if (gauge) gauge.setAttribute('aria-label', `Windmill speed ${displayRpm} RPM; 30 RPM is 100 percent and 40 RPM is overspeed`);
  const needle = appRoot.querySelector('[data-gauge-needle]');
  const clampedRpm = Math.max(0, Math.min(WINDMILL_GAUGE_MAX_RPM, rpm));
  if (needle) needle.setAttribute('transform', `rotate(${-90 + (clampedRpm / WINDMILL_GAUGE_MAX_RPM) * 180} 130 125)`);

  const slider = appRoot.querySelector('#speed-range');
  if (slider && state.draftSpeed === null && document.activeElement !== slider) {
    slider.value = String(Math.min(WINDMILL_MAX_OUTPUT, rawSpeed));
    setText('#speed-percent', `${Math.min(100, percent)}%`);
  }
  syncWindmillAnimation(appRoot.querySelector('.windmill-scene'), device);
}

function speedGauge(telemetry) {
  const rpm = Number.isFinite(telemetry.rpm) ? telemetry.rpm : 0;
  const clampedRpm = Math.max(0, Math.min(WINDMILL_GAUGE_MAX_RPM, rpm));
  const needleAngle = -90 + (clampedRpm / WINDMILL_GAUGE_MAX_RPM) * 180;
  return `
    <div class="output-gauge ${telemetry.rawSpeed > WINDMILL_MAX_OUTPUT ? 'is-over-limit' : ''}">
      <svg viewBox="0 0 260 155" role="img" aria-label="Windmill speed ${rpm.toFixed(1)} RPM; 30 RPM is 100 percent and 40 RPM is overspeed">
        <path class="gauge-track" pathLength="100" d="M30 125 A100 100 0 0 1 230 125" />
        <path class="gauge-zone gauge-green" pathLength="100" d="M30 125 A100 100 0 0 1 230 125" />
        <path class="gauge-zone gauge-yellow" pathLength="100" d="M30 125 A100 100 0 0 1 230 125" />
        <path class="gauge-zone gauge-red" pathLength="100" d="M30 125 A100 100 0 0 1 230 125" />
        <line class="gauge-needle" data-gauge-needle x1="130" y1="125" x2="130" y2="48" transform="rotate(${needleAngle} 130 125)" />
        <circle class="gauge-hub" cx="130" cy="125" r="9" />
        <text x="23" y="148">0</text>
        <text class="gauge-threshold-label" x="44" y="52">25</text>
        <text class="gauge-threshold-label gauge-normal-limit" x="190" y="53">30 · 100%</text>
        <text x="218" y="148">40</text>
      </svg>
      <div class="gauge-value"><strong data-gauge-rpm>${rpm.toFixed(1)} RPM</strong><span data-gauge-detail>${telemetry.percent}% demo speed · ${telemetry.outputVolts.toFixed(2)} V · raw ${telemetry.rawSpeed}</span></div>
    </div>`;
}

function windmillControl(device) {
  const receivedTelemetry = device.telemetry || { rawSpeed: 0, rpm: 0, enableOutput: 0 };
  const telemetry = {
    ...receivedTelemetry,
    rpm: Number(((receivedTelemetry.rawSpeed / WINDMILL_MAX_OUTPUT) * WINDMILL_NOMINAL_RPM).toFixed(1)),
    percent: Math.round((receivedTelemetry.rawSpeed / WINDMILL_MAX_OUTPUT) * 100),
    outputVolts: Number(((receivedTelemetry.rawSpeed / 4_096) * 10).toFixed(2)),
  };
  const details = device.identity || {};
  const online = device.status === 'online' && !device.stale;
  const safetyKnown = typeof telemetry.emergencyStopActive === 'boolean';
  const safetyState = !online || !safetyKnown ? 'unknown' : telemetry.emergencyStopActive ? 'stopped' : 'ready';
  const speedControlAvailable = safetyState === 'ready';
  const selected = Math.min(WINDMILL_MAX_OUTPUT, state.draftSpeed ?? telemetry.rawSpeed);
  const aboveConfiguredLimit = telemetry.rawSpeed > WINDMILL_MAX_OUTPUT;
  const safetyTitle = safetyState === 'ready' ? 'READY — DRIVE ENABLED' : safetyState === 'stopped' ? 'EMERGENCY STOP ACTIVE' : 'STATUS UNKNOWN — CONTROLS LOCKED';
  const safetyDetail = safetyState === 'ready'
    ? 'Speed control is active. Press the red button to stop the windmill.'
    : safetyState === 'stopped'
      ? 'Drive output is disabled. Reset is required before speed can be changed.'
      : 'Connect to the Moxa device to verify the safety output.';
  return `
    <div class="page-heading"><div><h2>Windmill control</h2><p>Drive control, pitch monitoring and PLC identity.</p></div></div>
    ${networkAlert(device)}
    <div class="grid grid-2">
      <div class="stack">
        <section class="panel">
          <div class="panel-header"><div><h3>Live windmill status</h3><p>${device.stale ? 'Last verified state' : 'Updated once per second'}</p></div></div>
          <div class="machine-stage ${device.stale ? 'stale' : ''}">
            ${windmillVisual(telemetry, device.stale)}
            <div class="machine-caption"><strong data-windmill-rpm-caption>${telemetry.rpm.toFixed(1)} rpm</strong><span data-windmill-percent-caption>${device.stale ? 'Waiting for verified data' : `${telemetry.percent}% of rated speed`}</span></div>
          </div>
        </section>
        <div class="metric-row">
          <div class="metric"><div class="metric-label">Actual speed</div><div class="metric-value"><span data-windmill-rpm-metric>${telemetry.rpm.toFixed(1)}</span><span class="metric-unit"> rpm</span></div></div>
          <div class="metric"><div class="metric-label">Raw register</div><div class="metric-value" data-windmill-raw-metric>${telemetry.rawSpeed}</div></div>
          <div class="metric"><div class="metric-label">Estimated AO0 output</div><div class="metric-value"><span data-windmill-volts-metric>${telemetry.outputVolts.toFixed(2)}</span><span class="metric-unit"> V</span></div></div>
        </div>
      </div>
      <div class="stack">
        <section class="panel">
          <div class="panel-header"><div><h3>Speed and safety control</h3><p>The displayed state is read directly from Moxa AO1.</p></div></div>
          <div class="panel-body">
            <div class="safety-state safety-${safetyState}" role="status" aria-live="polite">
              <span class="safety-light"></span>
              <div><span class="safety-kicker">DRIVE SAFETY STATUS</span><strong>${safetyTitle}</strong><small>${safetyDetail}</small></div>
            </div>
            <div class="safety-action">
              ${safetyState === 'ready'
                ? '<button class="button safety-stop-button" data-command="windmill-stop">STOP WINDMILL NOW</button>'
                : safetyState === 'stopped'
                  ? '<button class="button safety-reset-button" data-command="windmill-restart">RESET &amp; ENABLE DRIVE</button>'
                  : '<button class="button" disabled>CONTROL UNAVAILABLE</button>'}
            </div>
            ${speedGauge(telemetry)}
            ${aboveConfiguredLimit ? '<div class="output-limit-warning"><strong>OVERSPEED — POSSIBLE ATTACK</strong><span>The measured command exceeds 100%: more than 30 RPM / raw 3072 / 7.5 V. Normal operator control cannot request this value.</span></div>' : ''}
            <div class="range-row">
              <label for="speed-range">Demo speed ${speedControlAvailable ? '— changes apply automatically' : '— locked by safety state'}</label>
              <input id="speed-range" type="range" min="0" max="${WINDMILL_MAX_OUTPUT}" step="24" value="${selected}" ${speedControlAvailable ? '' : 'disabled'} />
              <div class="range-readout"><span>0</span><strong id="speed-percent">${Math.round((selected / WINDMILL_MAX_OUTPUT) * 100)}%</strong><span>100% = 30 RPM · 7.5 V</span></div>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-header"><div><h3>PLC information</h3><p>Read directly from input registers after connection.</p></div></div>
          <div class="panel-body">
            <dl class="detail-list">
              <div class="detail-row"><dt>Device name</dt><dd>${escapeHtml(details.deviceName || 'Not connected')}</dd></div>
              <div class="detail-row"><dt>Model</dt><dd>${escapeHtml(details.model || '—')}</dd></div>
              <div class="detail-row"><dt>Firmware</dt><dd>${escapeHtml(details.firmware || '—')}</dd></div>
              <div class="detail-row"><dt>MAC address</dt><dd>${escapeHtml(details.mac || '—')}</dd></div>
            </dl>
          </div>
        </section>
        ${connectionPanel('windmill', device)}
      </div>
    </div>`;
}

function readinessRow(level, title, detail) {
  const symbol = level === 'pass' ? '✓' : level === 'fail' ? '!' : '•';
  return `<div class="readiness-row readiness-${level}"><span class="readiness-symbol">${symbol}</span><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div></div>`;
}

function setupHelpView(device) {
  const info = demoSetup[state.activeDemo];
  const config = device.config || {};
  const interfaces = (state.networks || []).map((network) =>
    `<li><strong>${escapeHtml(network.interfaceName)}</strong> ${escapeHtml(network.localAddress)} /24</li>`).join('');
  const modelLevel = device.identity ? (device.identity.valid ? 'pass' : 'fail') : 'pending';
  const connectionLevel = device.status === 'online' && !device.stale ? 'pass' : device.lastError ? 'fail' : 'pending';
  const checklist = info.checkpoints.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `
    <div class="page-heading"><div><h2>Setup help</h2><p>Read-only checks first, then a short path to the likely fault.</p></div>${statusPill(device)}</div>
    <div class="grid grid-even help-grid">
      <section class="panel">
        <div class="panel-header"><div><h3>Demo readiness</h3><p>The app never writes during discovery or model validation.</p></div></div>
        <div class="panel-body readiness-list">
          ${readinessRow((state.networks || []).length ? 'pass' : 'fail', 'Local /24 interface', interfaces ? 'An interface is available for Find Moxa.' : 'Set a manual IPv4 address with subnet mask 255.255.255.0.')}
          ${readinessRow(config.ip ? 'pass' : 'pending', 'Moxa IP address', config.ip || 'Use Find Moxa or enter the address manually.')}
          ${readinessRow(modelLevel, `Correct model: ${info.expectedModel}`, device.identity ? `Detected ${device.identity.model || 'unknown model'}.` : 'The model is read from input register 5000.')}
          ${readinessRow(connectionLevel, 'Live Modbus data', device.status === 'online' && !device.stale ? `${info.readTest} succeeded.` : (device.lastError || 'Connect when the hardware is ready.'))}
        </div>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h3>Network interfaces</h3><p>Find Moxa scans active IPv4 /24 networks and directly checks the remembered and factory IP.</p></div></div>
        <div class="panel-body">
          ${interfaces ? `<ul class="plain-list">${interfaces}</ul>` : '<div class="empty-state compact">No scan-compatible interface found.</div>'}
          <div class="help-note"><strong>Known factory default</strong><span>Moxa ioLogik E1200 uses 192.168.127.254 / 255.255.255.0 after a factory reset. The app remembers the address you choose.</span></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h3>${state.activeDemo === 'fan' ? 'CPU fan' : 'Windmill'} hardware checks</h3><p>${escapeHtml(info.purpose)}</p></div></div>
        <div class="panel-body"><ol class="troubleshooting-list">${checklist}</ol></div>
      </section>
      <section class="panel">
        <div class="panel-header"><div><h3>Troubleshooting order</h3><p>Each step narrows the fault without changing device configuration.</p></div></div>
        <div class="panel-body">
          <ol class="troubleshooting-list">
            <li>Confirm the Moxa Power and Ready LEDs. Confirm the Ethernet port LED when the cable is connected.</li>
            <li>Confirm the computer has a 192.168.127.x address with subnet mask 255.255.255.0.</li>
            <li>Run Find Moxa. A usable result must show ${info.expectedModel} verified and Modbus TCP port 502 open.</li>
            <li>If EdgeIPS is inline, test once with a direct cable to separate wiring and IP issues from a security policy issue.</li>
            <li>Reconnect through EdgeIPS and verify that the selected policy permits the required Modbus reads and writes.</li>
            <li>Pull the network cable. The expected result is stale data, locked controls and automatic recovery after reconnection.</li>
          </ol>
        </div>
      </section>
    </div>`;
}

function diagnosticsView(device) {
  const rows = [...state.logs].reverse().map((entry) => `
    <tr><td>${formatDateTime(entry.timestamp)}</td><td class="log-level-${escapeHtml(entry.level)}">${escapeHtml(entry.level).toUpperCase()}</td><td>${escapeHtml(entry.source)}</td><td>${escapeHtml(entry.message)}</td></tr>`).join('');
  return `
    <div class="page-heading"><div><h2>Diagnostics</h2><p>Connection history for troubleshooting network-cable demonstrations.</p></div>${statusPill(device)}</div>
    <section class="panel">
      <div class="panel-header"><div><h3>Event log</h3><p>The full log is stored locally on this computer.</p></div><button class="button button-quiet" id="open-log-folder">Show log file</button></div>
      <div class="panel-body">
        <div class="log-toolbar"><span>${state.logs.length} events in this session</span><span>Latest events first</span></div>
        ${rows ? `<table class="log-table"><thead><tr><th>Time</th><th>Level</th><th>Source</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty-state">No events recorded yet.</div>'}
      </div>
    </section>`;
}

function render() {
  const preservedWindmill = state.activeDemo === 'windmill' && state.view === 'control'
    ? appRoot.querySelector('.windmill-scene')
    : null;
  if (!state.activeDemo) {
    appRoot.innerHTML = selectionView();
    return;
  }
  const device = state.devices[state.activeDemo];
  const content = state.view === 'diagnostics'
    ? diagnosticsView(device)
    : state.view === 'help' ? setupHelpView(device)
      : state.activeDemo === 'fan' ? fanControl(device) : windmillControl(device);
  appRoot.innerHTML = shell(content, device);
  if (state.activeDemo === 'windmill' && state.view === 'control') {
    const newWindmill = appRoot.querySelector('.windmill-scene');
    const activeWindmill = preservedWindmill || newWindmill;
    if (preservedWindmill && newWindmill) newWindmill.replaceWith(preservedWindmill);
    syncWindmillAnimation(activeWindmill, device);
  }
}

async function call(action, successTitle) {
  try {
    const result = await action();
    if (successTitle) toast(successTitle, 'The device state has been verified.', 'success');
    return result;
  } catch (error) {
    toast('Action failed', error.message || String(error), 'error');
    throw error;
  }
}

function scheduleSpeedUpdate(value, immediate = false) {
  speedControl.queuedValue = value;
  clearTimeout(speedControl.timer);
  speedControl.timer = setTimeout(flushSpeedUpdate, immediate ? 0 : SPEED_DEBOUNCE_MS);
}

function cancelPendingSpeedUpdate() {
  clearTimeout(speedControl.timer);
  speedControl.timer = null;
  speedControl.queuedValue = null;
  state.draftSpeed = null;
}

async function flushSpeedUpdate() {
  speedControl.timer = null;
  if (speedControl.inFlight || speedControl.queuedValue === null) return;

  const value = speedControl.queuedValue;
  speedControl.queuedValue = null;
  speedControl.inFlight = true;
  try {
    await window.hmi.command('windmill', 'windmill-speed', { value });
    if (speedControl.queuedValue === null && state.draftSpeed === value) state.draftSpeed = null;
  } catch (error) {
    toast('Speed change failed', error.message || String(error), 'error');
  } finally {
    speedControl.inFlight = false;
    if (speedControl.queuedValue !== null) scheduleSpeedUpdate(speedControl.queuedValue, true);
  }
}

appRoot.addEventListener('click', async (event) => {
  const select = event.target.closest('[data-select-demo]');
  if (select) {
    const id = select.dataset.selectDemo || null;
    cancelPendingSpeedUpdate();
    await call(() => window.hmi.selectDemo(id));
    state.activeDemo = id;
    state.view = 'control';
    state.draftSpeed = null;
    render();
    return;
  }

  const view = event.target.closest('[data-view]');
  if (view) {
    state.view = view.dataset.view;
    if (state.view === 'help') {
      try {
        state.networks = await window.hmi.getNetworks();
      } catch {}
    }
    render();
    return;
  }

  const disconnect = event.target.closest('[data-disconnect]');
  if (disconnect) {
    if (disconnect.dataset.disconnect === 'windmill') cancelPendingSpeedUpdate();
    await call(() => window.hmi.disconnect(disconnect.dataset.disconnect), 'Disconnected');
    return;
  }

  const retry = event.target.closest('[data-retry]');
  if (retry) {
    await call(() => window.hmi.retry(retry.dataset.retry));
    toast('Retry started', 'The app is attempting a fresh connection.');
    return;
  }

  const discover = event.target.closest('[data-discover]');
  if (discover) {
    const id = discover.dataset.discover;
    state.discovery[id] = 'loading';
    render();
    try {
      state.discovery[id] = await window.hmi.discover(id);
      if (!state.discovery[id].length) toast('No device found', 'Enter the IP manually or communicate with the Moxa device once so it appears in ARP.');
    } catch (error) {
      state.discovery[id] = [];
      toast('Discovery failed', error.message || String(error), 'error');
    }
    render();
    return;
  }

  const useIp = event.target.closest('[data-use-ip]');
  if (useIp) {
    const input = document.querySelector('input[name="ip"]');
    if (input) input.value = useIp.dataset.useIp;
    state.discovery[state.activeDemo] = null;
    return;
  }

  const command = event.target.closest('[data-command]');
  if (command) {
    const commandName = command.dataset.command;
    if (commandName === 'windmill-stop' || commandName === 'windmill-restart') cancelPendingSpeedUpdate();
    await call(() => window.hmi.command(state.activeDemo, commandName), 'Command completed');
    return;
  }

  if (event.target.closest('#open-log-folder')) await window.hmi.openLogFolder();
});

appRoot.addEventListener('input', (event) => {
  if (event.target.matches('#speed-range')) {
    state.draftSpeed = Number(event.target.value);
    document.querySelector('#speed-percent').textContent = `${Math.round((state.draftSpeed / WINDMILL_MAX_OUTPUT) * 100)}%`;
    scheduleSpeedUpdate(state.draftSpeed);
  }
});

appRoot.addEventListener('change', async (event) => {
  if (event.target.matches('#speed-range')) {
    scheduleSpeedUpdate(Number(event.target.value), true);
    return;
  }
  if (!event.target.matches('[data-auto-reconnect]')) return;
  const id = event.target.dataset.autoReconnect;
  const enabled = event.target.checked;
  try {
    const device = await window.hmi.setAutoReconnect(id, enabled);
    state.devices[id] = device;
    toast('Reconnect setting saved', enabled ? 'Automatic reconnect is enabled.' : 'Automatic reconnect is disabled.', 'success');
    render();
  } catch (error) {
    event.target.checked = !enabled;
    toast('Could not save setting', error.message || String(error), 'error');
  }
});

appRoot.addEventListener('submit', async (event) => {
  if (!event.target.matches('#connection-form')) return;
  event.preventDefault();
  const form = new FormData(event.target);
  const id = event.target.dataset.device;
  const config = {
    ip: form.get('ip'),
    port: Number(form.get('port')),
    unitId: Number(form.get('unitId')),
    autoReconnect: form.get('autoReconnect') === 'on',
  };
  try {
    await call(() => window.hmi.updateConfig(id, config));
    await call(() => window.hmi.connect(id));
  } catch {}
});

window.hmi.onState((device) => {
  const previous = state.devices[device.id];
  state.devices[device.id] = device;
  if (device.id === 'windmill' && device.status !== 'online') cancelPendingSpeedUpdate();
  if (device.status === 'online' && previous?.status !== 'online') toast('Connection restored', `${device.label} is online.`, 'success');
  if (['reconnecting', 'offline'].includes(device.status) && previous?.status === 'online') toast('Connection interrupted', 'Controls are locked while the app reconnects.', 'error');
  const canPatchWindmill = device.id === 'windmill'
    && state.activeDemo === 'windmill'
    && state.view === 'control'
    && previous
    && windmillStructureKey(previous) === windmillStructureKey(device)
    && appRoot.querySelector('.windmill-scene');
  if (canPatchWindmill) updateWindmillLive(device);
  else render();
});

window.hmi.onLog((entry) => {
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  if (state.view === 'diagnostics') render();
});

setInterval(() => {
  const device = state.devices[state.activeDemo];
  if (!device || state.view !== 'control') return;
  if (['reconnecting', 'offline'].includes(device.status)) render();
}, 1_000);

window.hmi.getState().then((initial) => {
  Object.assign(state, initial);
  render();
}).catch((error) => {
  appRoot.innerHTML = `<div class="empty-state"><h2>Could not start the HMI</h2><p>${escapeHtml(error.message)}</p></div>`;
});
