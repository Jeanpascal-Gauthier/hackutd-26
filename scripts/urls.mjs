// Prints the laptop's LAN IPv4 addresses and the URLs to type on the Quest and the console.
// Run on its own with `npm run demo:urls`; scripts/demo.mjs also prints it at start-up.
import os from "node:os";
import { pathToFileURL } from "node:url";

// Adapters that are never the venue network (WSL, Docker, VirtualBox, VPNs, Bluetooth).
const VIRTUAL = /vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware|Loopback|Bluetooth|tailscale|zerotier|utun|docker|veth|br-/i;

/** Non-internal IPv4 addresses, real adapters (Wi-Fi/Ethernet) first. */
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      out.push({ name, address: a.address, virtual: VIRTUAL.test(name) });
    }
  }
  return out.sort((x, y) => Number(x.virtual) - Number(y.virtual));
}

export function printUrls({ headset = true, form = true, serverPort = 8080, consolePort = 5173, headsetPort = 8081, formPort = 8090 } = {}) {
  const lan = lanAddresses();
  const real = lan.filter((a) => !a.virtual);
  const line = "-".repeat(64);
  console.log(line);
  console.log("FireSight demo URLs");
  console.log(`  Console (this laptop):  http://localhost:${consolePort}`);
  console.log(`  Server health:          http://localhost:${serverPort}/health`);
  if (headset) console.log(`  Headset (this laptop):  https://localhost:${headsetPort}   (accept the self-signed cert)`);
  if (headset) {
    if (real.length) {
      for (const a of real) console.log(`  Quest, same Wi-Fi:      https://${a.address}:${headsetPort}   (${a.name})`);
    } else {
      console.log("  Quest, same Wi-Fi:      no LAN address found (not on Wi-Fi?) - use USB or a tunnel, see DEMO.md");
    }
    console.log(`  Quest over USB:         adb reverse tcp:${headsetPort} tcp:${headsetPort}  then https://localhost:${headsetPort}`);
  }
  if (form) {
    console.log(`  Report form QR (print): http://localhost:${formPort}/qr`);
    for (const a of real) console.log(`  Report form, phones:    http://${a.address}:${formPort}/   (${a.name})`);
    console.log(`  Form via tunnel:        npx -y cloudflared tunnel --url http://localhost:${formPort}  then /qr?url=<tunnel URL>`);
  }
  const virtual = lan.filter((a) => a.virtual);
  if (virtual.length) console.log(`  (ignored virtual adapters: ${virtual.map((a) => `${a.name} ${a.address}`).join(", ")})`);
  console.log(line);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) printUrls();
