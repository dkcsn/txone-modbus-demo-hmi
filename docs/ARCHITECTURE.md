# Architecture and network resilience

## Process boundaries

The renderer displays state and sends validated IPC requests through a context-isolated preload bridge. It has no direct Node.js or network access. The Electron main process owns the window, settings, file logging, and the update check. All device communication runs in a separate Electron utility process (`device-host.cjs`).

```text
Renderer UI
    │ constrained IPC
    ▼
Electron main process
    ├── atomic settings + event log
    ├── GitHub update check
    │ message channel
    ▼
Device utility process
    ├── ConnectionManager per demo
    ├── Moxa identity validation
    ├── Modbus TCP client
    └── bounded local discovery
```

The split is required on macOS. Local Network privacy refuses plain sockets opened by the app's main process with `EHOSTUNREACH` and never shows the permission prompt, while a utility process is allowed through. If the utility process exits unexpectedly, the main process logs it and restarts it after one second.

## Connection state machine

Each demo has one serialized Modbus connection manager with these states:

```text
disconnected → connecting → online
                       └──→ reconnecting → offline
                                      └──→ online
```

- Connection timeout: 900 ms.
- Request timeout: 750 ms.
- Poll interval: 1 second.
- Retry delay: exponential from 500 ms, capped at 10 seconds, with jitter.
- Failed data is immediately marked stale.
- Commands require online, non-stale state.
- Requests and commands are serialized to avoid overlapping Modbus transactions.
- A model mismatch is non-retryable and never unlocks controls.

Settings are written through a temporary file and atomic rename. The IP address, port, Unit ID, active demo, and automatic-reconnect preference are stored locally; no username, password, or cookie is used.

## Device discovery

Discovery is deliberately bounded:

1. Enumerate active IPv4 interfaces with a `/24` netmask.
2. Probe the configured Modbus port with short timeouts and bounded concurrency.
3. Explicitly probe the remembered address and Moxa factory address `192.168.127.254`.
4. Correlate reachable endpoints with the operating system ARP table and Moxa OUI.
5. Read the identity registers and compare the model with the selected demo.

The application does not perform an unrestricted enterprise-network scan.

## Smooth windmill animation

Modbus polling updates telemetry once per second, but it does not reconstruct the windmill SVG. The rotor remains mounted and is animated using a compositor-friendly CSS transform. Speed changes use the Web Animations API's synchronized playback-rate update, preventing position jumps while retaining the actual measured RPM.

## Safety boundary

The HMI enforces the normal windmill command limit of raw `3072`, but it deliberately displays external values up to the physical 10 V range so the overspeed scenario remains visible. This software boundary is for the demonstration only and must not be treated as functional-safety protection.
