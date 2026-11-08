# Firewatch demo runbook

## CBRE map and action demo (no server required)

Run `npm run dev -w console` and open <http://localhost:5173/?fixture=map>.
For a fully offline schematic map, use <http://localhost:5173/?fixture=map&map=offline>.
Fixtures only run in the Vite development server.

1. Start with **6 buildings · 1,240 people · ~$380K at risk in the next 30 min**.
2. Scrub the forecast from Now to +30 min, or press **Play forecast**. Fire, smoke, flood water,
   crash queues and flooded roads advance together. Dashed links show related incidents; the fire
   pin has **3 calls** merged into one incident. The gas leak has a **140 m blast radius**.
3. Click **Main Street Lofts** on the map or in the prioritized list. Inspect its failure chain.
4. Press **Execute** on **Isolate gas supply & shut down HVAC**. It becomes **Done**, the chain
   step becomes **Interrupted**, and the timestamped execution appears in history. The building's
   risk score drops **100 → 40** and total exposure drops **$380K → $323K**.
5. Execute the evacuation action to reduce exposed people **1,240 → 1,060**. The impact card
   stays visible while working in the building drill-down.
6. **Reset scenario** clears local execution history and restores the starting forecast. Actions
   otherwise survive refresh in the same tab through session storage.

All scenario data and action reductions are illustrative, defined in `console/src/devFixture.ts`.
Execute records a local simulated action; it does not send commands to building equipment or dispatch
services. Google Maps and the schematic use the same forecast geometry. Google Maps automatically
falls back to the schematic while loading or when unavailable.

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
- **Phone call** to the Photon voice number: the ElevenLabs agent asks what happened and where, puts the emergency on the map (fires, crashes, anything else), and reads Firewatch's reply back. Setup in [Phone calls](#phone-calls-elevenlabs).
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
            report_incident {type, address, description, ...} -> tunnel -> POST /voice/incident -> pin + forecast on the map -> { reply } read back
                                     (a fire inside a building also starts the building lookup; the operator confirms it on the console)
```

**1. Server.** In `.env`: `VOICE_TOKEN=<long random string>` (turns the voice endpoints on) and `GEOAPIFY_API_KEY=<key>`
(free at geoapify.com; without it every address lookup fails). Then `npm run demo` as usual.

**2. Tunnel** (second terminal), so ElevenLabs can reach the server:
```sh
npx -y cloudflared tunnel --url http://localhost:8080
```
It prints `https://<name>.trycloudflare.com`. The URL changes every restart: update both tool URLs in ElevenLabs then.
Check it: `curl -XPOST https://<name>.trycloudflare.com/voice/incident -H 'x-firesight-token: <VOICE_TOKEN>' -H 'content-type: application/json' -d '{"type":"crash","address":"Campbell Road and Coit Road, Richardson, TX","description":"two cars crashed","lanes_blocked":"all"}'`
should answer `"ok":true` with "I have the location as…". Run `npm run demo:reset` afterwards.

**3. ElevenLabs agent** (ElevenAgents → the Firewatch agent). Paste these:

- **First message:** `FireWatch emergency line. What is your emergency, and where is it?`
- **System prompt:**
  ```text
  You are the FireWatch emergency line. People call you about fires, car crashes and anything else that
  needs first responders. Be calm and brief. Speak in short sentences.

  1. Find out what happened and where. Ask for the address, including the city. If they don't know it,
     ask for the nearest cross streets, a landmark or the building name, and the city.
     Report as soon as you know what happened and where. Do not wait to finish follow-up questions.
  2. Call report_incident. Pass the location exactly as they said it, and what happened in their own words.
     Then read the tool's reply to the caller word for word.
  3. If the reply is a question, ask it, then call report_incident again with the same type and address and
     their answer as the description. If the reply says it could not find the location, pass their new answer
     as the address.
  4. Ask one short follow-up question at a time about important missing details. Prioritize anyone hurt
     or trapped and how many, then the exact location (floor or room for a building fire), visible hazards,
     and access details. Only ask what fits this incident. Do not repeat questions already answered.
     If the tool already asked a question, let the caller answer it before asking another.
     Accept "I don't know". Never pressure the caller to investigate or move toward danger.
     Send each answer through report_incident with the same type and address. Keep the caller's wording
     and any uncertainty. Include relevant earlier caller words when needed to make an answer clear.
  5. If the caller tells you something new later (it got worse, someone is trapped, more lanes are blocked),
     call report_incident again with the same type and address and their words as the description, and read
     the reply. If they correct the location, call report_incident with the corrected address.

  Choosing report_incident's type:
  - fire: a fire or smoke, indoors or outdoors. Set in_building to true only if it is inside a building.
  - crash: a collision on a road. A burning car counts as a crash.
  - other: anything else. Put a short name in what, such as "gas leak", "flooding", "downed power line"
    or "medical emergency".

  Rules:
  - Never give your own safety or evacuation advice. Only say what the tools reply.
  - Never tell anyone to use an elevator.
  - The responder brief contains only what the caller said. Never invent or infer details from the
    incident type, map, forecasts, tool advice, or missing answers. Unanswered does not mean "none".
  - Preserve uncertainty, negation, counts, and corrections. Never turn "maybe" into a confirmed fact.
  - Leave out severity, lanes_blocked, or in_building unless the caller explicitly stated that detail.
  - Use short, direct sentences. Ask only for missing information that helps responders.
  - If a tool fails or takes too long, for a fire inside a building say: "Help is on the way. Leave by the
    nearest stairwell. Do not use the elevator." For anything else say: "Help is on the way. Move somewhere
    safe if you can."
  - Stay on the line until the caller is safe or hangs up.
  ```
- **Tool `report_incident`** (webhook): `POST https://<tunnel>/voice/incident`, header `x-firesight-token: <VOICE_TOKEN>`.
  Response timeout **10 s** (it waits at most 4 s for the geocoder). Body parameters:

  | Parameter | Type | Description for the LLM |
  |---|---|---|
  | `type` | enum `fire`, `crash`, `other` | Kind of emergency |
  | `address` | string | Where it is, exactly as the caller said it, including the city |
  | `description` | string | What the caller said happened, word for word |
  | `what` | string, optional | Short name for `other`, such as "gas leak" |
  | `in_building` | boolean, optional | Fires only: true if the fire is inside a building |
  | `severity` | enum `minor`, `serious`, `critical`, `unknown`, optional | Only if the caller made it clear |
  | `lanes_blocked` | enum `all`, `some`, `unknown`, optional | Crashes only: how much of the road is blocked |
  | `caller` | system dynamic variable | The caller's number: `system__caller_id` in ElevenLabs' docs; check the name in the dashboard |

- **Remove the old `report_address` and `report_fire` tools** from the agent. `report_incident` handles the initial report and all follow-up answers, so it is the only tool (`/voice/address` and `/voice/report` still work).
- Link the agent to the Photon SIP number (server/API.md, "Setup checklist", step 3).

**4. Test**, in this order: the curl above → the ElevenLabs in-browser test call → a real phone call (a crash, then a
fire inside a building: report the address, hear the reply, then answer focused follow-up questions).
Confirm that the responder brief contains only the stated address and caller answers, with no forecast,
assumed severity, dispatch status, or invented details.

**Wait times** (measured with the real Nemotron model): `/voice/incident` at most about 4 s; forecasts appear on the map
within about 15 s; `/voice/report` 1 s when it asks
a follow-up, about 5 s when it locates the room (8.5 s worst seen). The server gives the agent `AGENT_TIMEOUT_MS`
(default 12 s); past that the rule-based locator answers in under a second, so `report_fire` always replies before its
20 s timeout. The agent says "One moment, locating you" first, so the caller never sits in silence.

**During the call:** every emergency appears in `mapIncidents`. Once the address of a fire inside a building comes in, the console asks the operator to **confirm the building outline**.
Until then every report from the building gets "Help is on the way. We are confirming the building now. Do not use
the elevator." and is located after confirmation, so confirm quickly. Without an address, calls run on the demo building.

## Between judges
```sh
npm run demo:reset
```
This clears the incident (`POST /live/reset`: no fire, no reports, an empty map). In `--mock` mode it also restarts the scripted calls.
The console has no reset button in live mode (its Reset/Replay buttons only appear in mock mode).
Reload the Quest tab if it looks stale (the Engine 3 progress shown there is simulated locally).
Note: with the headset open, a new recommendation is **accepted and dispatched automatically** by the headset.

## CBRE portfolio impact (90 seconds)
Live numbers depend on real wind and the time of day (one run gave ~$5K), so the judged run is **scripted**: the same
three calls with hand-built forecasts, assessed at a weekday 2 pm. Server running (`npm run demo`), console open, then
in a second terminal (any shell):

| Say | Run | The console shows |
|---|---|---|
| "A fire behind the strip mall on Campbell." | `npm run demo:cbre` | Radius, ~4 buildings light up; data center: smoke hits the HVAC intake in 8 min |
| "Now a crash on Coit." | `npm run demo:cbre` | Linked (not merged) to the fire; the data center's fuel road turns red |
| "And a water main bursts." | `npm run demo:cbre` | Water spreads toward the data center's basement electrical room |
| "Here's the whole picture." | (card) | "6 buildings · 1,240 people · ~$380K at risk in the next 30 min" |
| "Close the dampers, deploy flood barriers." | `npm run demo:cbre -- --execute` (or Execute on the console) | ~$90K |

Each run prints the headline, top building, first failure and top action. `-- --all` puts all three in at once;
`-- --reset` clears the map and starts over (so does `npm run demo:reset`). Same thing over HTTP:
`POST /portfolio/demo/step`, `/run`, `/reset` (server/API.md, "Scripted CBRE demo").

**Live alternative** (real geocoding, wind and elevation; numbers vary): report these, in order, by phone or the console's
"Add a report": fire at `7651 Campbell Rd, Dallas, TX 75248`, crash at `Campbell Rd and Coit Rd, Richardson, TX`
(all lanes blocked), flooding at `2210 N Coit Rd, Richardson, TX` (type other, what "flooding", "water main burst").
Run `npm run demo:reset` before switching back to the script.

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
