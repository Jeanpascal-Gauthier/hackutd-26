# FireSight demo runbook

## Once, before demo day
1. Root `.env` has `NVIDIA_API_KEY=...` (the agent needs it).
2. `npm install` (repo root).
3. `npm install --prefix headset` (the headset is not a workspace; it has its own lockfile).

## Start everything (one terminal, any shell)
```sh
npm run demo
```
This starts the server (live mode + Nemotron agent, :8080), the console (:5173) and the headset (HTTPS, :8081).
When all three are up it prints the URLs, including the Quest URL for this laptop's Wi-Fi IP.
The server log must say `mode=live  reports->agent processReport()`.
**Ctrl+C stops all three.** If one crashes, the others are stopped too, so just run it again.

Options: `npm run demo -- --mock` (scripted calls, no agent), `-- --no-agent` (live, rule-based locator),
`-- --no-headset`, `-- --watch` (server restarts on file edits; off by default so a save can't wipe the incident).

Second terminal: `npm run demo:check` (is everything up?), `npm run demo:urls` (URLs again), `npm run demo:reset`.

**How reports get in:** type them into the console's "Add a report" panel (or `POST /ingest`, below).
Real 911 texts are not wired up yet: the Photon SMS adapter (`agent/photon/index.ts`) is still a TODO.

## URLs
| What | URL |
|---|---|
| Console (laptop) | http://localhost:5173 |
| Headset in the laptop browser | https://localhost:8081 (accept the certificate warning) |
| Quest | see below |
| Server health | http://localhost:8080/health should return `{"ok":true,"mock":false}` |

## Opening the headset on the Quest (needs HTTPS for WebXR), in order of preference
1. **Same Wi-Fi.** Join the Quest to the laptop's Wi-Fi and open `https://<laptop IP>:8081` (shown by `npm run demo:urls`).
   Accept the warning: Advanced, then Proceed. The certificate is cached in `headset/.iwsdk/https`, so you accept it once.
   If it doesn't load, the venue Wi-Fi probably blocks device-to-device traffic: use option 2.
   Windows Firewall: Node is allowed inbound on *Public* networks. If Windows marks the venue Wi-Fi as *Private*, allow
   Node there too (Windows Security, Firewall, Allow an app, Node.js, tick Private).
2. **Tunnel** (works on any Wi-Fi with internet; the agent needs internet anyway). In a second terminal:
   ```sh
   npx -y cloudflared tunnel --url https://localhost:8081 --no-tls-verify
   ```
   Open the printed `https://<random>.trycloudflare.com` on the Quest. It has a real certificate, so there's no warning.
   The page, `/fs-api` and the `/fs-ws` WebSocket all go through this one tunnel (tested). The URL changes every
   time you restart it. Ctrl+C stops it.
3. **USB cable.** Needs `adb` (Android platform-tools, not installed on this laptop) and Quest developer mode.
   `adb devices` then `adb reverse tcp:8081 tcp:8081`, and open `https://localhost:8081` on the Quest.

Reuse one headset tab on the Quest; reload it rather than opening new tabs.

## Between judges
```sh
npm run demo:reset
```
This clears the incident (`POST /live/reset`: no fire, no reports). In `--mock` mode it also restarts the scripted calls.
The console has no reset button in live mode (its Reset/Replay buttons only appear in mock mode).
Reload the Quest tab if it looks stale (the Engine 3 progress shown there is simulated locally).
Note: with the headset open, a new recommendation is **accepted and dispatched automatically** by the headset.

## If something breaks
- **Agent slow or down (NVIDIA API):** nothing to do. Each report that errors or takes over 20 s falls back to the
  rule-based locator by itself (the server log shows `[agent] ... using the rule-based locator`).
- **No internet / no key:** stop it and run `npm run demo -- --mock` (scripted demo, no agent).
- **"Port(s) already in use":** another dev server is running. `netstat -ano | findstr :8080` shows its PID;
  close that terminal (or `taskkill /PID <pid> /T /F` if you're sure it's yours).
- **Headset tab blank or "Not secure":** use `https://`, not `http://`, and accept the warning.
- **Send a test report** (PowerShell: type `curl.exe`, not `curl`):
  `curl.exe -X POST localhost:8080/ingest -H "content-type: application/json" -d "{\"text\":\"smoke in the break room on the 7th floor\",\"caller\":\"test\"}"`
  Expect `"roomId":"7-break"` and a `reply`. Run `npm run demo:reset` afterwards.

## 30-second pre-demo checklist
- [ ] `npm run demo` is running; its log says `mode=live` and `reports->agent processReport()`.
- [ ] `npm run demo:check` shows four OK lines.
- [ ] Console open at http://localhost:5173 and showing "live" + connected.
- [ ] Quest: headset tab loaded, building visible, Enter VR works. Battery is fine.
- [ ] `npm run demo:reset` done: no leftover reports from the last run.
- [ ] First report text ready to paste into the console's "Add a report" panel.
