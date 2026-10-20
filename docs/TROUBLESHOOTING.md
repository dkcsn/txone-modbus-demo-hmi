# Troubleshooting

## Find Moxa returns no device

1. Confirm link lights on the computer, switch, and ioLogik.
2. Confirm that the active Ethernet interface has an IPv4 address.
3. Put the computer and ioLogik in the same untagged VLAN/subnet.
4. For the factory address `192.168.127.254`, assign the computer another address in `192.168.127.0/24`, such as `192.168.127.240/24`.
5. Confirm that TCP port `502` is not blocked.
6. Enter the known address manually; discovery is intentionally bounded and does not scan arbitrary large or routed networks.

ARP alone does not prove that Modbus is reachable. A device can appear in a switch controller or ARP table while VLAN assignment, routing, host firewall, client isolation, or TCP port policy still prevents the application from reaching it.

## The Moxa appears in UniFi but ping and the HMI fail

Check the switch ports' **native/untagged VLAN**. A Mac connected to an access port normally sends untagged traffic and therefore joins that port's native VLAN; it does not automatically join every VLAN allowed on a trunk. Configure both endpoint ports with the same native network, or configure a VLAN interface explicitly on the Mac.

Also verify that a stale fixed-IP reservation in the router is not being mistaken for the ioLogik's actual static address. DHCP reservations do not reconfigure a statically addressed Moxa device.

## Wrong device/model

The app accepts only:

- CPU Fan: E1214 or E1214-T.
- Windmill: E1241 or E1241-T.

If another model answers on port `502`, the identity is displayed but controls remain locked. Select the correct demo or connect the expected hardware.

## Status changes to stale or offline

This is expected after a cable removal or failed Modbus request. Commands are intentionally locked because the displayed value is no longer verified. Reconnect the cable and wait for automatic recovery, or select **Retry now**.

## Windmill shows more than 100%

This is intentional. The normal HMI limit is raw `3072` / 7.5 V / 30 RPM. A measured value above that limit indicates an external write or misconfiguration. Raw `4096` is 10 V / 40 RPM / approximately 133% and is shown as a red overspeed condition.

## Locate the application log

Open **Diagnostics** and select the action that reveals the log in the operating system's application-data directory. The log records connection attempts, selected demos, command completion, discovery results, communication loss, and reconnect events.

Useful information when reporting a problem:

- Operating system and app version.
- Selected demo and expected Moxa model.
- Computer IPv4 address and subnet mask.
- Moxa IP address, firmware, and MAC address.
- Whether ping and TCP port `502` succeed.
- Relevant timestamps and messages from `hmi.log`.
