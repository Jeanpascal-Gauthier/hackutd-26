# FireSight demo runbook

## Once, before demo day
1. Root `.env` has `NVIDIA_API_KEY=...` (the agent needs it). For phone calls also `VOICE_TOKEN` (see [Phone calls](#phone-calls-elevenlabs)).
2. Root `.env` has `GEOAPIFY_API_KEY=...` (address lookup; without it every lookup fails). Leave
   `OVERPASS_API_URL` as in `.env.example` (public, no key). Restart the server after editing `.env`, then
   `curl.exe localhost:8080/buildings/providers` must show `"geoapify":{"configured":true`.
   This only checks that the key is set, not that it works: run one address lookup (below) to be sure.
3. `npm install` (repo root).
4. `npm install --prefix headset` (the headset is not a workspace; it has its own lockfile).

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
- **Phone call** to the Photon voice number: the ElevenLabs agent asks what happened and where, puts the emergency on the map (fires, crashes, anything else), and reads FireSight's reply back. Setup in [Phone calls](#phone-calls-elevenlabs).
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
**The headset loads the building once, when the tab opens.** Reload the Quest tab after every building change
(address building activated, "Use demo building", or `demo:reset` from an address building).

## Building from an address (live mode only)
Without an address, everything runs on the 12-floor demo building. Live mode only: in `--mock` the panel says
"Address lookup is off in the scripted demo." and the API returns 409.

**Stairwells on an address building:** stair B's door on the fire floor is assumed propped open (listed under the
building's assumptions and as a deficient fire door in `GET /inspections`). The forecast shows smoke filling stair B
from the fire floor up while stair A stays clear, so FireSight says "Leave now by Stairwell A; do not use Stairwell B
or the elevator". This works on whichever floor the fire is reported.

**Console steps** (INCIDENT BUILDING panel; it jumps to the top of the column while a lookup is pending):
1. Type the street address with the city in **Incident address**, click **Find**.
   Shows a spinner: `Finding "<address>"…`, and "Address entered on a console".
2. **Needs confirmation** (amber pill): "Confirm the burning building", the geocoded address, a mini map with
   numbered outlines and a list, nearest first ("At the address" / "N m away", floors, use). Click **Confirm** on
   the right one (it changes to "Confirming…"). It always asks, even with a single outline.
   If nothing is mapped there, it skips this step and builds an estimated building at that point.
3. **Loading:** `Generating the building model for <address>…`, then briefly `Loading <name> from the server…`.
4. **Active:** the panel heading is the building's name, with an **Estimated layout** pill, its address, floors and
   footprint, and an OCCUPANCY estimate. The incident restarts on it (no fire, no reports); the log is kept.
   Reload the Quest tab.
5. **Back to the demo building:** "Use demo building instead", then **Use demo building** ("This clears the
   incident on every screen."). The panel shows the **Demo building** pill. Reload the Quest tab.

**Reports that arrive during a lookup** (searching, needs confirmation, loading) are **held**: stored with no
room, and the caller gets "Help is on the way. We are confirming the building now. Do not use the elevator."
After activation they are located on the new building one by one in arrival order (log: "Held report from
… located: …"). Callers are not messaged again.

**How a caller's address gets in:**
- **iMessage / any text through the agent:** if the caller writes an address ("fire at 800 W Campbell Rd,
  Richardson, 3rd floor"), the agent's `find_building` tool starts the lookup and the caller gets the same
  "confirming the building" reply. The panel says "Address from caller <number>". You still confirm the outline.
  Not with `--no-agent`, or when the agent fell back to the rule-based locator: then type the address yourself.
- **QR form:** optional "Building address" field. It starts the lookup before the report is sent, so that report
  is held (caller shows as `form:<name>`). If the lookup fails, the report still goes in on the current building.
- Same address again while a lookup is pending or active: ignored. A different address replaces the pending one.

**Same thing with curl.exe** (PowerShell, no console needed):
```powershell
curl.exe -X POST localhost:8080/incident/address -H "content-type: application/json" -d "{\"address\":\"800 W Campbell Rd, Richardson, TX\",\"caller\":\"test\"}"
# -> "status":"searching". Watch the status (repeat until needs_confirmation, active or failed):
(curl.exe -s localhost:8080/state | ConvertFrom-Json).buildingLookup | Select-Object status, query, error
# Candidates (pick an id):
(curl.exe -s localhost:8080/state | ConvertFrom-Json).buildingLookup.candidates | Select-Object id, name, floors, distanceMeters
# Optional: a report now is held (reply "Help is on the way. We are confirming the building now…", no roomId):
curl.exe -X POST localhost:8080/ingest -H "content-type: application/json" -d "{\"text\":\"smoke on the 2nd floor\",\"caller\":\"test\"}"
# Confirm (use a real id from the list) -> "status":"loading", then active:
curl.exe -X POST localhost:8080/incident/building -H "content-type: application/json" -d "{\"buildingId\":\"osm:way:123\"}"
(curl.exe -s localhost:8080/state | ConvertFrom-Json).building   # new id, version + 1
# Back to the demo building (clears the incident):
curl.exe -X POST localhost:8080/incident/building/demo
```
Lookup results are cached in the server's memory for 5 minutes (a server restart clears them), so a repeat
within that time doesn't call Geoapify or Overpass again.

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

**3. ElevenLabs agent** (ElevenAgents → the FireSight agent). Paste these:

- **First message:** `FireWatch emergency line. What is your emergency, and where is it?`
- **System prompt:**
  ```text
  You are the FireWatch emergency line. People call you about fires, car crashes and anything else that
  needs first responders. Be calm and brief. Speak in short sentences.

  1. Find out what happened and where. Ask for the address, including the city. If they don't know it,
     ask for the nearest cross streets, a landmark or the building name, and the city.
     For a fire, the address is all you need. Never ask which floor or room.
  2. Call report_incident. Pass the location exactly as they said it, and what happened in their own words.
     Then read the tool's reply to the caller word for word.
  3. If the reply is a question, ask it, then call report_incident again with the same type and address and
     their answer as the description. If the reply says it could not find the location, pass their new answer
     as the address.
  4. If the caller tells you something new later (it got worse, someone is trapped, more lanes are blocked),
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
  - Never guess a detail. Leave out severity or lanes_blocked if the caller did not make it clear.
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

- **Remove the old `report_address` and `report_fire` tools** from the agent. Callers are no longer asked for a floor or room, so `report_incident` is the only tool (`/voice/address` and `/voice/report` still work).
- Link the agent to the Photon SIP number (server/API.md, "Setup checklist", step 3).

**4. Test**, in this order: the curl above → the ElevenLabs in-browser test call → a real phone call (a crash, then a
fire inside a building: address only, then the evacuation reply).

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
In live mode this (`POST /live/reset`) **returns to the demo building** and clears everything: the address
lookup, fire, reports, recommendation, dispatches, agent trail, incident log, the map's incidents, and the agent's memory of callers.
In `--mock` mode it clears the incident and restarts the scripted calls (mock never leaves the demo building).
The console has no reset button in live mode (its Reset/Replay buttons only appear in mock mode).
- **Next judge on the demo building:** nothing more. Reload the Quest tab if the last judge used an address building.
- **Next judge on the address building:** after the reset, type the address again and **Confirm** the same outline
  (steps above), then reload the Quest tab. Within 5 minutes of the last lookup it comes from the cache.

Reload the Quest tab if it looks stale (the Engine 3 progress shown there is simulated locally).
Note: with the headset open, a new recommendation is **accepted and dispatched automatically** by the headset.

## If something breaks
- **Agent slow or down (NVIDIA API):** nothing to do. Each report that errors or takes over 20 s falls back to the
  rule-based locator by itself (the server log shows `[agent] ... using the rule-based locator`).
- **No internet / no key:** stop it and run `npm run demo -- --mock` (scripted demo, no agent).
- **"Port(s) already in use":** another dev server is running. `netstat -ano | findstr :8080` shows its PID;
  close that terminal (or `taskkill /PID <pid> /T /F` if you're sure it's yours).
- **Headset tab blank or "Not secure":** use `https://`, not `http://`, and accept the warning.
- **Building lookup failed** (red box in the INCIDENT BUILDING panel; the incident stays on the current building).
  Each Geoapify or Overpass call gives up after 10 s. The box shows why:
  - "Geoapify lookup timed out. Please retry." / "Overpass lookup timed out. Please retry."
  - "Geoapify is temporarily rate limited. Please retry later." (same for Overpass; public Overpass limits often)
  - "Address search is unavailable. Configure GEOAPIFY_API_KEY on the server." (no key: fix `.env`, restart)
  - "Geoapify rejected the server credentials or access settings." (bad key)

  Click **Retry lookup** once. If it fails again, don't wait: **Use demo building instead**, then **Use demo
  building**, and run the demo on the demo building. Careful: reports held during the failed lookup are **not**
  located on the current building (they stay without a room), and "Use demo building" clears them, so have those
  callers send their report again. New reports after the failure are processed normally.
- **Send a test report** (PowerShell: type `curl.exe`, not `curl`):
  `curl.exe -X POST localhost:8080/ingest -H "content-type: application/json" -d "{\"text\":\"smoke in the break room on the 7th floor\",\"caller\":\"test\"}"`
  On the demo building, expect `"roomId":"7-break"` and a `reply`. Run `npm run demo:reset` afterwards.

### Overpass down: offline building snapshots
**Before judging, while the network works**, save every address you might demo (commit the files):
```sh
npm run snapshot -w server -- "800 W Campbell Rd, Richardson, TX" "<backup address>"
```
Each address becomes `server/snapshots/<slug>.json`. Add `--building osm:way:N` after an address to save a candidate
other than the nearest, and `--alias "UTD Activity Center"` for other ways a caller might say it. `-- --help` lists the options.

- **Geoapify or Overpass slow, rate-limited or down:** nothing to do. The server serves the saved copy for that address,
  and candidates and Confirm work as live. For 60 s after a failure it uses the saved copy without retrying.
- **Venue Wi-Fi dead:** set `BUILDINGS_OFFLINE=1` in `.env` and restart `npm run demo`. The server never calls the APIs
  and serves only saved addresses; any other address fails with "no saved copy" (`offline_no_snapshot`).
- **How you know a saved copy was used:** the server log says `Building outlines from an offline copy saved <date>; live
  lookup unavailable (<reason>)`, and the building's first note in the console reads `Offline copy saved <date>; ...`.
- Check what's saved: `curl.exe localhost:8080/buildings/providers` shows `snapshots: { offlineMode, saved }`.

## 30-second pre-demo checklist
- [ ] `npm run demo` is running; its log says `mode=live` and `reports->agent processReport()`.
- [ ] `npm run demo:check` shows four OK lines.
- [ ] Console open at http://localhost:5173 and showing "live" + connected.
- [ ] Quest: headset tab loaded, building visible, Enter VR works. Battery is fine.
- [ ] `npm run demo:reset` done: no leftover reports from the last run.
- [ ] INCIDENT BUILDING panel shows the intended building: **Demo building** pill, or the address building's name
      with **Estimated layout**. Quest tab reloaded after any building change.
- [ ] Demoing an address: `curl.exe localhost:8080/buildings/providers` shows geoapify `"configured":true`, and the
      address was looked up and confirmed once today.
- [ ] First report text ready to paste into the console's "Add a report" panel.
- [ ] QR card shows the right URL (scan it with your own phone and send one test report, then reset).
- [ ] Photon: text the line once from an iPhone and get a reply (or the log says `photon: off` on purpose).
