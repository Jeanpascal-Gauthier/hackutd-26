# FireSight demo runbook

## Once, before demo day
1. Root `.env` has `NVIDIA_API_KEY=...` (the agent needs it). For phone calls also `VOICE_TOKEN` and `GEOAPIFY_API_KEY` (see [Phone calls](#phone-calls-elevenlabs)).
2. `npm install` (repo root).
3. `npm install --prefix headset` (the headset is not a workspace; it has its own lockfile).

## Start everything (one terminal, any shell)
```sh
npm run demo
```
This starts the server (live mode + Nemotron agent, :8080), the console (:5173), the headset (HTTPS, :8081),
the QR report form (:8090) and the Photon line when its credentials are in `.env` (see `.env.example`).
When all three are up it prints the URLs, including the Quest URL for this laptop's Wi-Fi IP.
The server log must say `mode=live  reports->agent processReport()`.
**Ctrl+C stops all three.** If one crashes, the others are stopped too, so just run it again.

Options: `npm run demo -- --mock` (scripted calls, no agent), `-- --no-agent` (live, rule-based locator),
`-- --no-headset`, `-- --no-form`, `-- --no-photon`, `-- --watch` (server restarts on file edits; off by default so a save can't wipe the incident).

Second terminal: `npm run demo:check` (is everything up?), `npm run demo:urls` (URLs again), `npm run demo:reset`.

**How reports get in** (all of them end at the server's ingest path, and the caller gets the reply):
- **Phone call** to the Photon voice number: the ElevenLabs agent asks for the address, then where the fire is, and reads FireSight's reply back. Setup in [Phone calls](#phone-calls-elevenlabs).
- **iMessage** to the project's Photon 2.0 line (iPhones; the person texts first). Needs `PHOTON_PROJECT_ID` +
  `PHOTON_API_KEY` in `.env`; the demo's first line says `photon: on (Photon 2.0)`. It polls every 2 s, so no
  webhook or tunnel. Shared iMessage lines are **per person**: each judge's phone must be registered first
  (uses one seat), then they text the number Photon assigns them. Two ways:
  - On the QR form: "Prefer iMessage? (iPhone)" -> enter phone -> it shows the number and a tap-to-text link.
  - By hand: `npm run photon:assign -- +14155550123` prints the number to tell them; `-- --list` shows everyone. If the line fails it retries every 15 s and the rest of the demo keeps running.
  Test without a line: `npm run photon -w agent -- --terminal`. For phone calls see [Phone calls](#phone-calls-elevenlabs).
- **QR form** for any phone, including Android: print or show `http://localhost:8090/qr` on the table card.
  Phones on the same Wi-Fi open `http://<laptop IP>:8090/`. If the venue Wi-Fi isolates devices:
  `npx -y cloudflared tunnel --url http://localhost:8090`, then open `/qr?url=<tunnel URL>` for the QR.
- The console's "Add a report" panel (operator typing).

## URLs
| What | URL |
|---|---|
| Console (laptop) | http://localhost:5173 |
| Headset in the laptop browser | https://localhost:8081 (accept the certificate warning) |
| Quest | see below |
| Server health | http://localhost:8080/health should return `{"ok":true,"mock":false}` |
| Report form / its QR | http://localhost:8090/ and http://localhost:8090/qr |

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

## Phone calls (ElevenLabs)

```
caller -> Photon voice number -SIP-> ElevenLabs voice agent (speech-to-text, voice)
            report_address {address, caller} -> tunnel -> POST /voice/address -> building lookup -> operator confirms on the console
            report_fire    {text, caller}    -> tunnel -> POST /voice/report  -> agent, merge, forecast -> { reply } read back to the caller
```

**1. Server.** In `.env`: `VOICE_TOKEN=<long random string>` (turns the voice endpoints on) and `GEOAPIFY_API_KEY=<key>`
(free at geoapify.com; without it every address lookup fails). Then `npm run demo` as usual.

**2. Tunnel** (second terminal), so ElevenLabs can reach the server:
```sh
npx -y cloudflared tunnel --url http://localhost:8080
```
It prints `https://<name>.trycloudflare.com`. The URL changes every restart: update both tool URLs in ElevenLabs then.
Check it: `curl -XPOST https://<name>.trycloudflare.com/voice/address -H 'x-firesight-token: <VOICE_TOKEN>' -H 'content-type: application/json' -d '{"address":"800 W Campbell Rd, Richardson, TX"}'`
should answer `"ok":true` with "Thank you, I have the address…". Run `npm run demo:reset` afterwards.

**3. ElevenLabs agent** (ElevenAgents → the FireSight agent). Paste these:

- **First message:** `FireSight emergency line. What is the address of the building?`
- **System prompt:**
  ```text
  You are the FireSight emergency line for fires in buildings. Be calm and brief. Speak in short sentences.

  1. Ask for the address of the building. When the caller gives it, call report_address with the address exactly
     as they said it, including the city if they said one. Then say the tool's reply.
     If they don't know the address, ask for the building name or the nearest cross streets and use that.
     If they still can't say, go on to step 2.
  2. Ask which floor and which room or part of the building the fire or smoke is in.
     Say "One moment, locating you." and call report_fire with the caller's words exactly.
  3. Read the tool's reply to the caller word for word. If the reply is a question, ask it, then call
     report_fire again with their answer.
  4. If the caller tells you something new later (another floor, more smoke, someone trapped), call report_fire
     again with their words and read the reply.

  Rules:
  - Never give your own evacuation advice. Only say what the tools reply.
  - Never tell anyone to use an elevator.
  - Call report_address only once per address. Don't call it again for the same building.
  - If a tool fails or takes too long, say: "Help is on the way. Leave by the nearest stairwell. Do not use the elevator."
  - Stay on the line until the caller is safe or hangs up.
  ```
- **Tool `report_address`** (webhook): `POST https://<tunnel>/voice/address`, header `x-firesight-token: <VOICE_TOKEN>`,
  body parameters `address` (string, "The building's address exactly as the caller said it") and `caller` (the caller's
  number: the system dynamic variable for the caller id, `system__caller_id` in ElevenLabs' docs; check the name in the
  dashboard). Response timeout **10 s** (it answers in about 0.05 s).
- **Tool `report_fire`** (webhook): `POST https://<tunnel>/voice/report`, same header, body parameters `text` (string,
  "What the caller said about where the fire or smoke is, word for word") and `caller` (as above).
  Response timeout **20 s**.
- Link the agent to the Photon SIP number (server/API.md, "Setup checklist", step 3).

**4. Test**, in this order: the curl above → the ElevenLabs in-browser test call → a real phone call (address, then the
location, then the evacuation reply).

**Wait times** (measured with the real Nemotron model): `/voice/address` about 0.05 s; `/voice/report` 1 s when it asks
a follow-up, about 5 s when it locates the room (8.5 s worst seen). The server gives the agent `AGENT_TIMEOUT_MS`
(default 12 s); past that the rule-based locator answers in under a second, so `report_fire` always replies before its
20 s timeout. The agent says "One moment, locating you" first, so the caller never sits in silence.

**During the call:** once an address comes in, the console asks the operator to **confirm the building outline**.
Until then every report from the building gets "Help is on the way. We are confirming the building now. Do not use
the elevator." and is located after confirmation, so confirm quickly. Without an address, calls run on the demo building.

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
- [ ] QR card shows the right URL (scan it with your own phone and send one test report, then reset).
- [ ] Photon: text the line once from an iPhone and get a reply (or the log says `photon: off` on purpose).
