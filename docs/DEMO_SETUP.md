# Demo setup and operation

## Select a demo

The start screen offers **CPU Fan** and **Windmill**. Selecting a different demo disconnects the previous one so that only one hardware setup can receive commands at a time.

## Connect to Moxa

1. Connect the computer and ioLogik to the same Ethernet network.
2. Select the demo.
3. In **Connection settings**, enter the IP address, TCP port `502`, and Unit ID `1`.
4. Alternatively, use **Find Moxa**. Discovery checks active `/24` interfaces, the remembered address, and `192.168.127.254`.
5. Select a matching result. The application reads the model, firmware, MAC address, and device name directly from the ioLogik.
6. Select **Save and connect**.

Controls remain locked until the expected model has been verified and a complete live snapshot has been read.

## CPU Fan demo

Required Moxa model: **ioLogik E1214** or **E1214-T**.

The HMI reads and writes the first two coils using the mapping from the original demo:

| HMI state | Coil 0 | Coil 1 |
| --- | --- | --- |
| Off | false | false |
| Low | true | true |
| High | true | false |

Usage:

1. Confirm **ONLINE** and recent live data.
2. Choose **Off**, **Low**, or **High**.
3. Confirm that the physical fan and the displayed feedback agree.
4. Remove the network cable to demonstrate that data becomes stale and commands lock.
5. Reconnect the cable and observe automatic recovery when **Reconnect automatically** is enabled.

## Windmill demo

Required Moxa model: **ioLogik E1241** or **E1241-T**.

Normal operation is limited to `0–3072`, corresponding to `0–7.5 V`, `0–30 RPM`, and `0–100%` rated speed. Slider changes are applied automatically.

### Emergency stop

- **READY — DRIVE ENABLED** means the output-enable register reports that the drive is enabled.
- **STOP WINDMILL NOW** writes speed `0` and disables the output.
- The restart action restores the enable output with speed still at `0`; the operator then selects a speed.

The on-screen stop is a demonstration control, not a certified emergency-stop function. Physical safety circuitry must not depend on the application, Ethernet, Modbus, or the computer.

### Overspeed/attack demonstration

The operator slider cannot exceed `3072` (7.5 V / 30 RPM). A separate attacker or engineering tool can write a value above this limit directly to the ioLogik:

- `3072` = 7.5 V = 30 RPM = 100%.
- `4096` = 10 V = 40 RPM = approximately 133%.

The HMI continues reading the actual raw register. Values above `3072` move the gauge into the red area and display **OVERSPEED — POSSIBLE ATTACK**. Moving the normal slider or stopping the windmill returns the output to the validated range.

## Disconnect and reconnect demonstration

With automatic reconnect enabled:

1. Start the demo and confirm live operation.
2. Remove the Ethernet cable.
3. The next failed poll marks the data stale, locks commands, and begins bounded reconnect attempts.
4. Reinsert the cable.
5. The application verifies the Moxa identity again and resumes only after a successful telemetry read.

Disable **Reconnect automatically after a network interruption** when the presenter wants recovery to require an explicit retry.
