# Installation

## macOS

The provided macOS package targets Apple Silicon Macs.

1. Download `TXOne Modbus Demo HMI-<version>-arm64.dmg` from GitHub Releases.
2. Open the downloaded DMG.
3. Drag **TXOne Modbus Demo HMI** into **Applications**.
4. Open the app from Applications.

Development builds are not yet notarized. If Gatekeeper blocks the first launch, open **System Settings → Privacy & Security**, review the blocked-app message, and choose **Open Anyway** only when the package came from this repository or another trusted TXOne source.

## Windows

### Installer

1. Download `TXOne Modbus Demo HMI Setup <version>.exe`.
2. Run the installer.
3. Choose an installation folder when prompted.
4. Start the application from the Start menu or desktop shortcut.

### Portable version

Download `TXOne Modbus Demo HMI <version>.exe` and run it directly. No installation is required. Settings and logs are still stored in the user's application-data directory.

Unsigned development builds may trigger Windows SmartScreen. Verify that the file came from the official repository before choosing **More info → Run anyway**.

## Network prerequisites

- Ethernet connection to the demo network.
- An IPv4 address in the same subnet/VLAN as the Moxa ioLogik.
- TCP port `502` permitted between the computer and the ioLogik.
- No client isolation or firewall rule blocking local device communication.
- Default Modbus Unit ID: `1`.

For a factory-default ioLogik at `192.168.127.254/24`, a direct-connected computer can use a manual address such as:

```text
IP address: 192.168.127.240
Subnet mask: 255.255.255.0
Router: leave empty for a direct connection
```

Do not assign the computer the same address as the ioLogik.

## Signed production distribution

Public partner distribution should add:

- Apple Developer ID Application signing and Apple notarization for DMG/ZIP packages.
- An Authenticode code-signing certificate for Windows executables.
- Branded `.icns` and `.ico` application icons.

Signing removes most operating-system trust warnings and lets recipients verify the publisher and package integrity.
