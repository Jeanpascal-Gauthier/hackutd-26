# FireSight server API

One port (default `8080`) serves both HTTP and the WebSocket. All bodies are JSON. CORS is open.

`npm run dev` starts **mock mode**: scripted calls replay through the real model. `MOCK=0 npm run dev` starts **live mode**: it waits for real reports. Both modes support every endpoint below.

## Public building lookup

These additive endpoints retrieve public building information. The existing `/building`, incident,
console, headset, and simulation continue to use the demo building. Importing a public record does
not activate it as an incident or make it suitable for evacuation guidance.

### Setup

The server loads the root `.env` file. Fill in its `GEOAPIFY_API_KEY` value locally, then restart
the server. Keep credentials out of Git and browser code. The tracked `.env.example` contains
the setting names; `.env` and `.env.*` variants are ignored, while `.env.example` remains public.

```dotenv
GEOAPIFY_API_KEY=your_key_here
OVERPASS_API_URL=https://overpass-api.de/api/interpreter
```

Overpass normally needs no key. `OVERPASS_API_URL` is optional and allows a hosted or self-managed
instance. Public instances have capacity limits; use bounded lookups and caching during a prototype,
and a suitable hosted or self-managed instance for deployment. Overture dataset imports and
Mappedin venue imports are separate future integrations; neither is enabled by these settings.

Start the server and console from the repository root using `npm.cmd run dev` on Windows.
Open `http://localhost:8080/buildings/providers` first: `geoapify.configured` should be `true`
after filling the key and restarting. Configuration status does not test provider credentials or
network connectivity.

| Endpoint | Purpose |
|---|---|
| `GET /buildings/providers` | Configuration status without credential values. |
| `GET /buildings/search?q=...` | Geoapify address/name candidates with coordinates and match information. |
| `POST /buildings/resolve` | Find building candidates, or import an explicitly selected OSM building. |
| `GET /buildings/:id` | Retrieve an imported record from this server's cache. |
| `GET /buildings/:id/rooms` | Retrieve floors, room labels, mapped connections, and data coverage for a future agent integration. |

### Address and building selection

First try an address lookup in your browser:

```text
http://localhost:8080/buildings/search?q=1313%20Broadway%2C%20Tacoma%2C%20WA
```

Review the returned address candidates. A match may identify a street, neighborhood, or larger site,
so it does not automatically identify a building. Use the selected result's latitude and longitude
in a JSON request to `POST /buildings/resolve`:

```json
{ "lat": 47.250945, "lon": -122.439413 }
```

To send that POST from PowerShell, use the following (the first response is expected to be 409
when building candidates are available; the catch prints its JSON details):

```powershell
$lookupBody = @{ lat = 47.250945; lon = -122.439413 } | ConvertTo-Json
try {
  Invoke-RestMethod -Uri 'http://localhost:8080/buildings/resolve' -Method Post `
    -ContentType 'application/json' -Body $lookupBody | ConvertTo-Json -Depth 20
} catch {
  $_.ErrorDetails.Message
}
```

When building candidates exist, the endpoint returns **409** with code
`building_selection_required` and a candidate list, even when only one outline is found.
Confirm the correct outline, then submit the same coordinates with its returned ID:

```json
{ "lat": 47.250945, "lon": -122.439413, "buildingId": "osm:way:123" }
```

`osm:way:123` is an illustrative ID; use the actual candidate ID. A selected building must be one
of the candidates for that location. With no mapped outlines, the response contains a location-only
record and explicit warnings. The API does not choose the nearest building automatically.

After choosing the correct candidate, put its actual ID into this request:

```powershell
$lookupBody = @{ lat = 47.250945; lon = -122.439413; buildingId = 'osm:way:123' } | ConvertTo-Json
Invoke-RestMethod -Uri 'http://localhost:8080/buildings/resolve' -Method Post `
  -ContentType 'application/json' -Body $lookupBody | ConvertTo-Json -Depth 20
```

Use the resulting record's ID for the record and room-catalog endpoints. IDs containing colons can
be URL-encoded, for example `osm%3Away%3A123`. Cached records are held in memory and cleared when
the server restarts; responses identify their retrieval and expiry times, including stale status.

### Geometry, room labels, and missing information

Public records are independent of the rectangular `Building` type in `shared/types.ts`:

- Footprints use geographic GeoJSON Polygon/MultiPolygon coordinates in **[longitude, latitude]**
  order, including courtyard holes. They are not the demo model's local meter coordinates.
- Floors retain source `level` values separately from signposted `level:ref` labels such as `G`
  or `B1`. Source floor numbers are not automatically shifted or restricted to floors 1-12.
- Rooms retain stable source IDs, original names, room numbers, purposes, source levels, original
  tags, and available geometry. Unnamed rooms stay unnamed; a labeled point is not a room boundary.
- Connections reflect mapped evidence only. Door states remain unknown, and this phase always
  reports `completeness.routeReady: false`.
- Source attribution, license, retrieval dates, and available source timestamps accompany records.
  Missing heights, interiors, occupancy, and safety-system data are not replaced with demo values.

The catalog can be supplied to Nemotron in a later integration to match caller descriptions to
existing room IDs. The current demo-specific agent locator is not changed by these endpoints.
Interior coverage is partial even when some rooms are mapped; it does not establish a complete
floor plan or a validated routing graph. A client should continue accepting incident descriptions
and displaying known locations when model information is unavailable.

Missing Geoapify configuration returns **503**. Invalid request input returns **400**, upstream
failures return **502**, timeouts return **504**, and unknown cached IDs return **404**. Provider
errors are sanitized so API keys and upstream error bodies are not returned to clients.

References: [Geoapify geocoding](https://apidocs.geoapify.com/docs/geocoding/),
[OSM indoor tagging](https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging),
[Overpass instance guidance](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html).

## For the agent

There are two ways to connect. Pick one.

### Option A: in-process (the server calls the agent)
Export this from `agent/index.ts`:

```ts
export async function processReport(input: { text: string; caller: string }): Promise<{
  roomId?: string; confidence?: number;                       // a room id from shared/building.json, 0..1
  recommendation?: { actions: string[]; callerReply?: string };
  trail?: { tool: string; input: unknown; output: unknown; ms: number }[];
  reply?: string;                                             // text back to the caller
}>
```

Start with `AGENT=1 npm run dev` (add `MOCK=0` for live mode). The server loads it from `server/src/agent/bridge.ts`, and `POST /ingest` calls it for every report, including the mock demo's scripted calls. The startup log line says which one is active (`reports->agent processReport()`).
- If the export is missing, the server logs a warning and uses its rule-based locator.
- If one call throws, takes longer than `AGENT_TIMEOUT_MS` (default 20000), or returns a non-object, **that report** falls back to the rule-based locator. The error is logged as `[agent] …`.
- The `/ingest` response carries `reply`, which the Photon adapter texts to the caller.

### Option B: separate process (the agent calls the server)
The agent never imports server code. Its tools call these endpoints:

| Agent tool | Endpoint |
|---|---|
| `locate_room` | `GET /building` (room ids, names, floors) and the agent's own reasoning |
| `merge_reports` | `GET /state` → `reports`, `origin` (the server also merges) |
| `run_spread` / `find_clear_exits` | `POST /forecast` |
| `check_inspections` | `GET /inspections?floor=7` (or `GET /building` → `inspections`, `doors`, `sprinklers`) |
| `write_recommendation` | `POST /forecast` → `recommendation` is a draft to improve. Add the fire-floor's inspection findings as context, e.g. "Sprinkler in 7-break impaired (head obstructed, inspection overdue); 60-min door to Stairwell B found propped open: expect smoke in stair B." |
| (final) | `POST /ingest` with the agent's result |

### `POST /ingest`
A report comes in. Required fields: `text` and `caller`.

```json
{ "text": "smoke from the break room on 7", "caller": "+12145550101" }
```

On its own, this runs the server's rule-based locator. **If the agent already did the work, send its result too.** The server then skips its locator:

```json
{
  "text": "smoke from the break room on 7",
  "caller": "+12145550101",
  "roomId": "7-break",            // a room id from GET /building; needs confidence
  "confidence": 0.9,              // 0..1
  "recommendation": { "actions": ["Evacuate floors 7–12 by Stairwell A"], "callerReply": "Leave now by Stairwell A" },
  "trail": [{ "tool": "locate_room", "input": {"text": "…"}, "output": {"roomId": "7-break"}, "ms": 420 }],
  "reply": "Leave now by Stairwell A. Do not use the elevator."
}
```

- Every agent field is optional. A follow-up with no room yet is just `{ text, caller, reply: "Which floor are you on?" }`.
- Limits: `recommendation.actions` 1–5 strings; `trail` at most 50 steps, each `{tool, input, output, ms}`.
- After ingest, the server merges every report into `origin`. When the origin moves, it re-runs the forecast. The agent's `recommendation` always wins over the server's draft, and `trail` is appended to `state.trail`.
- **Response:** `{ ok, report, reply }`. `reply` is the agent's `reply`, else the recommendation's `callerReply`. This is the text to send back to the caller through Photon.
- **Errors:** `400 { ok:false, errors:[…] }` names each bad field.

### Origin merge rule (demo decision)

Keep the current rule in both `server/src/live/merge.ts` and `agent/core/tools/mergeReports.ts`:
each located report contributes its location confidence, doubled if its text contains a fire word
(`fire`, `flame(s)`, `burning`, `blaze`). A report supports its own room at full weight. Smoke-only
reports on higher floors support a lower candidate at half weight; other reports count against
that candidate. Highest supporting score wins; ties prefer the lower floor, then the earlier candidate.
Conflicting evidence reduces the winner's confidence, which is capped at 0.95.

Ready answer for judges: "We give reported flames more weight because they point more directly to
the source; smoke can travel. That preference is bounded, and conflicting reports lower confidence."
For example, at 0.8 location confidence per report:

| Reports | Origin | Confidence |
|---|---|---|
| Smoke in `7-break` and `9-stair-b`; flames in `10-conf` | `10-conf` (1.6 support vs 1.2) | 0.40 |
| Same reports plus smoke in `10-hall` | `7-break` (1.6 tie; lower floor wins) | 0.46 |
| Original reports, but flames located at only 0.2 confidence | `7-break` (1.2 vs 0.4) | 0.66 |

This is a demo heuristic, not a calibrated probability or a multiple-fire model. Fire words are
matched literally, so negated phrases such as "no flames" also get doubled. Inspection deficiencies
explain the building's vulnerabilities; they do not add votes to the origin score.

### `POST /forecast`
A what-if run. **It does not change the incident.**

```json
{ "origin": "7-break", "minutes": 30 }
```
`minutes` is optional, 1–60 (default 30).

**Response:** `{ ok, origin, minutes, summary, exits, recommendation }`
- `summary`:
  - `floorsAtRisk`: number[]
  - `peopleAtRisk`: number
  - `stairBlocked`: `{ "stair-b": { "12": 11, … } }`, meaning stair → floor → first smoky minute
  - `roomsBurningAtEnd`: string[]
- `exits[]`: `{ floor, people, flags, stair, blockedAt, atRiskAt }`, with `stair` = the clear stairwell id.

### `GET /state`
Returns the current `IncidentState` (`shared/types.ts`), the same object the WebSocket sends.

### `GET /building`
`{ building, occupants, sprinklers, doors, inspections }`
- `building` is `shared/building.json`.
- `occupants[]`: `{ room, count, flags }`, one per occupied room.
- `sprinklers` maps room id → `active` | `impaired` | `none`.
- `doors[]`: `{ a, b, ratingMinutes }` for every door link; `ratingMinutes` 0 = ordinary door, 20 = room door, 60 = stair/elevator door.
- `inspections[]`: the building's inspection records, as of 2026-11-07 (annual cycle). One per sprinklered room, one per fire-rated door, and one fire alarm and one standpipe record per floor (180 in all).

```json
{ "id": "fire-door:7-hall|7-stair-b", "system": "fire-door", "target": "7-hall|7-stair-b", "floor": 7,
  "lastInspected": "2026-10-21", "nextDue": "2027-10-21", "status": "deficient",
  "finding": "Door found propped open (hold-open device not released to fire alarm)" }
```
  - `system`: `sprinkler` | `fire-door` | `fire-alarm` | `standpipe`.
  - `target`: a room id (sprinkler), the door's `a|b` (fire-door), or `floor-N` (fire-alarm, standpipe). `id` is `system:target`.
  - `status`: `pass` | `overdue` (`nextDue` is past) | `deficient` (open `finding`). Most records pass.
  - Demo: `sprinkler:7-break` is `deficient` and overdue ("Sprinkler head obstructed; repair ticket open."), and `fire-door:7-hall|7-stair-b` is `deficient` (propped open). These match the spread model's inputs: the 7-break sprinkler is impaired and the stair B door is open.

### `GET /inspections`
The same records, filtered. Query parameters are all optional and combine: `floor` (number), `system`, `status`.
`GET /inspections?floor=7&status=deficient` → `{ ok: true, inspections: [ …the two demo records… ] }`. An unknown value returns `400 { ok:false, errors:[…] }`.

## For the headset and console (WebSocket)

- **Server → client:** `{ "type": "state", "state": IncidentState }`. Sent on connect and after every change.
- **Client → server:**
  - `{ "type": "setSimMinute", "minute": 0..30 }`: scrub the forecast for everyone.
  - `{ "type": "acceptRecommendation" }`
  - `{ "type": "dispatch", "roomId": "7-break" }`: appends to `state.dispatches`.

### State fields for drawing
- `rooms[]`: `{roomId, fire, smoke}`, each 0..1, at `simMinute`.
- `origin`: `{roomId, confidence}`, the likely fire room.
- `exits[]`: per occupied floor, `{floor, people, flags, stair, blockedAt, atRiskAt, route}`. `route` is the list of rooms to light green: hall → clear stairwell → down to floor 1.
- `recommendation`: pending actions for the commander. On `acceptRecommendation` it moves to `accepted: {recommendation, time}`, so keep the route lit while `accepted` is set.
- `dispatches[]`: `{roomId, time}`.
- `trail[]`: agent tool calls `{tool, input, output, ms}`.
- `reports[]`: each `{id, caller, text, roomId?, confidence?, time, reply?, channel?}`. `reply` is what FireSight told that caller (follow-up question or advice), so a console can show "caller said / FireSight replied" transcripts. `channel` is `voice` for phone calls.
- `log[]`: a ready-made incident log, `{time, kind, text}`, where `kind` is report, origin, recommendation, accepted or dispatch (replies to callers are logged as `report` entries starting "Replied to"). Last 200 entries.

## Phone calls (Photon → ElevenLabs → FireSight)

```
judge's phone -> Photon number -SIP-> ElevenLabs voice agent (speech-to-text, talking, text-to-speech)
                                         | webhook tool report_fire {text, caller}
                                         v
                tunnel -> POST /voice/report -> same ingest path as /ingest (agent, merge, forecast, trail)
                                         | { reply }
                voice agent reads the reply back <-+
```

### `POST /voice/report`
The webhook tool an ElevenLabs voice agent calls during a call. It is off unless the server starts with `VOICE_TOKEN` set (503 otherwise), and it requires that token, because a tunnel makes the server public.

- **Auth:** header `x-firesight-token: <VOICE_TOKEN>` (or `Authorization: Bearer <VOICE_TOKEN>`). Wrong or missing gives 401.
- **Body:** `{ "text": "<what the caller said>", "caller": "<caller's phone number>" }`. `caller` is optional (defaults to `voice caller`). Agent-result fields are ignored on this endpoint.
- **Response:** `{ ok, reply, roomId }`. `reply` is ready to speak: "floors 6–12" becomes "floors 6 to 12", parentheticals are dropped, at most 3 sentences. When the location is unclear, `reply` is the follow-up question; if processing fails it is still a safe line ("Help is on the way. Which floor are you on…"). `roomId` is the located room or `null`.
- **Effects:** identical to `/ingest`: the report (marked `channel: "voice"`, with its `reply`) appears on every screen, the agent trail and the incident log update ("Call from +1555…").

### Setup checklist
1. **Server:** `AGENT=1 MOCK=0 AGENT_TIMEOUT_MS=12000 VOICE_TOKEN=<long random string> npm run dev`.
2. **Tunnel:** `npx -y cloudflared tunnel --url http://localhost:8080` gives `https://<name>.trycloudflare.com`. The URL changes when the tunnel restarts; update the tool URL then.
3. **Photon:** a purchased (voice-capable) number; Voice page → SIP profile, inbound on, target `sips:sip.rtc.elevenlabs.io:5061` (TLS).
4. **ElevenLabs → ElevenAgents:** create an agent.
   - First message: "FireSight. Where is the fire or smoke?"
   - System prompt: ask where the fire or smoke is; say "One moment, locating you" and call `report_fire` with exactly what the caller said; read the tool's `reply` back word for word; if the reply is a question, ask it and call the tool again with the answer; never give your own evacuation advice.
   - Tool `report_fire` (webhook): `POST https://<tunnel>/voice/report`, header `x-firesight-token`, body `text` (string, what the caller said) and `caller` (the caller's number from ElevenLabs' system dynamic variable, likely `system__caller_id`; check their docs), timeout about 25 s.
   - Link the agent to the Photon SIP number.
5. **Test:** `curl -XPOST https://<tunnel>/voice/report -H 'x-firesight-token: <token>' -H 'content-type: application/json' -d '{"text":"smoke in the break room on 7","caller":"+15555550100"}'`, then the ElevenLabs in-browser test call, then a real phone.

## Control

| Endpoint | Does |
|---|---|
| `GET /health` | `{ ok, mock }` |
| `POST /live/reset` | Clears the incident: no fire, no reports. Also stops a running demo. |
| `POST /mock/replay` | Mock mode: restart the scripted demo. |
| `POST /mock/reset` | Mock mode: stop, minute 0. |

## Remote access (Quest headset, other laptops)

The Quest browser only allows WebXR over HTTPS, so it must reach the server through `wss://`. HTTP and the WebSocket share one port, so one tunnel covers both:

```sh
brew install cloudflared                      # once
cloudflared tunnel --url http://localhost:8080
# prints https://<random-name>.trycloudflare.com
```

- HTTP: `https://<random-name>.trycloudflare.com/health`
- WebSocket: `wss://<random-name>.trycloudflare.com`

The URL changes each time the tunnel restarts. **Clients should not hard-code `ws://localhost:8080`.** Read it from a `?server=` query parameter or a Vite env variable instead, for example `const WS_URL = new URLSearchParams(location.search).get("server") ?? "ws://localhost:8080"`. The headset app itself also needs HTTPS (its own dev server or a second tunnel).
