# FireSight server API

One port (default `8080`) serves both HTTP and the WebSocket. All bodies are JSON. CORS is open.

`npm run dev` starts **live mode**: it waits for reports and supports address lookup.
`MOCK=1` opts into scripted calls on the demo building; `npm run demo -- --mock` sets this
automatically. Address lookup is disabled in mock mode.

## Public building lookup

These endpoints retrieve public building information. On their own they do not change the incident:
resolving a record does not activate it. To run the incident on a real building, use the address
flow in [Building from an address](#building-from-an-address-live-mode), which builds a simulation
building from the confirmed record (with an estimated layout) and activates it.

### Setup

The server loads the root `.env` file. Fill in its `GEOAPIFY_API_KEY` value locally, then restart
the server. Keep credentials out of Git and browser code. The tracked `.env.example` contains
the setting names; `.env` and `.env.*` variants are ignored, while `.env.example` remains public.
The server entry point loads this file relative to its source location before initializing
the app and agent, including when launched directly without CLI environment-file flags.
Explicitly supplied environment variables take precedence. A missing `.env` is allowed.
Development uses Node's built-in watcher with the tsx TypeScript loader. If a restart still
shows old configuration, check for an older process holding port 8080 before launching again.

```dotenv
GEOAPIFY_API_KEY=your_key_here
OVERPASS_API_URL=https://overpass-api.de/api/interpreter
```

With `GEOAPIFY_API_KEY` configured, outlines use Geoapify's managed Place Details API
(`features=building`) with the same key. This returns the containing building's OSM identity,
footprint and available height/floor tags. It does not query public Overpass servers or import
mapped interiors. A building candidate still requires operator confirmation. If no containing
outline is returned, the record is explicitly location-only; nearby buildings are not searched.

Set `BUILDING_PROVIDER=overpass` to opt into nearby outlines and mapped indoor features instead.
Without a Geoapify key, coordinate-based resolve also defaults to Overpass. Overpass normally needs
no key. `OVERPASS_API_URL` allows a hosted or self-managed instance. Public instances have capacity
limits; use bounded lookups and caching during a prototype, and a suitable hosted or self-managed
instance for deployment. Overture dataset imports and
Mappedin venue imports are separate future integrations; neither is enabled by these settings.

Start the server and console from the repository root using `npm.cmd run dev` on Windows.
Open `http://localhost:8080/buildings/providers` first: `geoapify.configured` should be `true`
after filling the key and restarting. Configuration status does not test provider credentials or
network connectivity.

`GET /buildings/providers` also reports `buildingLookup.provider` so the selected outline
provider is visible without exposing credentials. If it reports `overpass` and address search
succeeds but the outline lookup times out, remove `BUILDING_PROVIDER=overpass` or set it to
`geoapify` and restart. Switching public Overpass hosts or increasing timeouts does not fix an
unresponsive backend. Overpass requests identify the project, allow up to 45 seconds of query
execution, and use a 60-second HTTP deadline to accommodate queueing and response transfer.
These limits apply to both outline and interior requests; Geoapify retains its 10-second deadline.
Address lookup starts asynchronously, so clients receive progress updates while the provider runs.
Overpass is an explicitly selectable provider, not an automatic fallback after a Geoapify error.
Provider failures keep the current incident active;
they are never interpreted as an empty map.

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
of the candidates for that location. With no outline returned, the response contains a location-only
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
[Geoapify building details](https://apidocs.geoapify.com/docs/place-details/),
[OSM indoor tagging](https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging),
[Overpass instance guidance](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html).

## Building from an address (live mode)

A caller (voice or text) gives the address of the burning building. The server geocodes it, lists the
OpenStreetMap outlines there, the **operator confirms one on the console**, and the server turns that
record into a simulation `Building` and makes it the incident building. The spread model, exits,
recommendation, `GET /building`, `/inspections`, `/forecast` and the locator all run on it. With no
address, everything runs on the demo building exactly as before. **Mock mode (`MOCK=1`)
never leaves the demo building**: lookup events and endpoints are ignored (HTTP 409) with a `building`
log line.

### Flow and `IncidentState.buildingLookup.status`

| Status | Meaning |
|---|---|
| `searching` | Geocoding the address (Geoapify, top result), then looking up its building outline (Geoapify by default; nearby Overpass outlines when opted in). `match` appears once geocoded. |
| `needs_confirmation` | `candidates` (summaries, nearest first; `distanceMeters` 0 = the point is inside) wait for the operator. Always asked, even with one candidate. |
| `loading` | The confirmed record is loaded, a `Building` synthesized (`server/src/buildings/synthesize.ts`), occupants estimated. With no outline returned by the chosen provider, the server skips confirmation and builds from the location-only record. |
| `active` | The building is the incident building. |
| `failed` | `error` says why. The incident stays on the previous building. Retry with the same or another address; after a failed confirmation, `confirmBuilding` can be sent again. |

- **Activation** bumps `IncidentState.building.version` (`building` is always set: `{id, name, version, layoutEstimated}`; the demo is `id: "demo"`). Clients re-fetch `GET /building` when `id` or `version` changes. The incident restarts on the new rooms: no fire, no recommendation, no dispatches; `occupants` are the estimate (`estimated: true`); `log` and `trail` are kept. Log lines have `kind: "building"`.
- **Occupancy** comes from the agent's `estimateOccupancy(building, Date.now())` (agent/index.ts, loaded in live mode whatever `AGENT` says). The trail gets `{ tool: "estimate_occupancy", input: { buildingId, use, localTime }, output: { total, byFloor, basis }, ms }`. If the export is missing or throws: no occupants and the log line "Occupancy estimate unavailable…".
- **Repeats are ignored:** a lookup whose normalized text (trimmed, spaces collapsed, case-folded) equals the current lookup's `query` or `match.formatted` does nothing unless that lookup `failed`. So does the same address said another way or shorter ("800 West Campbell Road" after "800 W Campbell Rd, Richardson, TX": street words abbreviated, filler dropped, `server/src/live/address.ts`); one that adds detail ("100 Main St, Plano" after "100 Main St") is a new lookup. A different address supersedes a lookup in flight (its late results are dropped); the incident stays on the current building until the new one is confirmed.
- **Reports during a lookup** (`searching`, `needs_confirmation`, `loading`) are **held**: stored with no `roomId`, no locator or agent call, and the fixed reply **"Help is on the way. We are confirming the building now. Do not use the elevator."** This includes `/ingest` with an agent result (it was located on the old building) and a report whose own processing started the lookup. After activation each held report is processed again on the new building, one at a time in arrival order, and goes through the normal update (merge, forecast, exits, recommendation; log "Held report from … located: …"). Callers are not messaged again.
- **Back to the demo:** `useDemoBuilding` / `POST /incident/building/demo`, and `POST /live/reset` (`npm run demo:reset`), return to the demo building with no lookup and an empty incident.
- The processor (agent or rule-based locator) is always told the active building: in-process, the agent's `processReport(input, ctx)` gets `{ ...defaultContext, building }`. A located `roomId` that the active building doesn't have falls back to the rule-based locator for that report.

### `POST /incident/address`
`{ "address": "800 W Campbell Rd, Richardson, TX", "caller": "+15550100" }` (`caller` optional). Same trust level as `/ingest` (no token); the agent's `find_building` tool and the QR form call it. Returns as soon as the lookup has started (never waits on Overpass): `{ ok: true, lookup }` with `lookup.status` `"searching"`, or the current lookup plus `unchanged: true` for a repeat. `400 { ok:false, error }` for an address under 3 or over 500 characters; `409` in mock mode.

### `POST /incident/building`
`{ "buildingId": "osm:way:123" }`, one of `buildingLookup.candidates`. Returns at once with `{ ok: true, lookup }` (`status: "loading"`); watch the state for `active` or `failed`. `409 { ok:false, error }` when no lookup is waiting or the id isn't a candidate (or in mock mode).

### `POST /incident/building/demo`
Back to the demo building (clears the lookup and the incident). `{ ok: true, lookup: null }`.

### Candidate summaries
`BuildingCandidateSummary` (shared/types.ts): `{ id, name, address, floors, heightMeters, use, distanceMeters, outline }`. `use` is the OSM `building` tag, read from the candidate's `tags` (candidates from `POST /buildings/resolve` now carry the descriptive tags: `building`, `building:use`, `building:levels`, `amenity`, `name`, …). `outline` is in metres around the geocoded point (x east, z south) for a mini map.

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

Start with `AGENT=1 npm run dev` (live mode by default; `MOCK=1` opts into scripted calls). The server loads it from `server/src/agent/bridge.ts`, and `POST /ingest` calls it for every report, including the mock demo's scripted calls. The startup log line says which one is active (`reports->agent processReport()`).
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
`{ building, occupants, sprinklers, doors, inspections }` for the **active** building (the demo unless an address was confirmed; re-fetch when `state.building.id`/`version` changes).
- `building` is `shared/building.json` plus `profile` (`{ id: "demo", source: "demo", use: "office", floors: 12, layoutEstimated: false, … }`), or a synthesized building with `profile` (`source: "osm"`, `address`, `location`, `timezone`, `outline`, `layoutEstimated: true`, `assumptions`, `attribution`).
- Looked-up buildings: `occupants` are estimates (`estimated: true`), `sprinklers`/`doors` come from the generator, `inspections` is `[]` (and `GET /inspections` returns `[]`).
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

- **Server → client:** `{ "type": "state", "state": IncidentState }`. Sent at once on connect, then after changes, coalesced: at most one message per 100 ms (`WS_BROADCAST_MS`, 0 sends every change), always ending on the final state.
- **Client → server:**
  - `{ "type": "setSimMinute", "minute": 0..30 }`: scrub the forecast for everyone.
  - `{ "type": "acceptRecommendation", "incidentId"?: "inc-1" }`: with no id, accepts `state.recommendation` (and marks the owning map incident accepted, if any). With an id, accepts that map incident's recommendation, and the global one too if it is the same object.
  - `{ "type": "dispatch", "roomId": "7-break" }`: appends to `state.dispatches` (a room of the active building).
  - `{ "type": "dispatchIncident", "incidentId": "inc-1", "unit"?: "Engine 3" }`: appends to the incident's `dispatches`; `open` becomes `dispatched`. No room needed. Ignored on a resolved incident.
  - `{ "type": "setIncidentPhase", "incidentId": "inc-1", "phase": "open"|"dispatched"|"on_scene"|"resolved" }`
  - `{ "type": "addIncidentNote", "incidentId": "inc-1", "text": "…" }`: at most 500 characters; an incident keeps its last 50.
  - Events naming an unknown incident are ignored with a server log line.
  - `{ "type": "executeAction", "propertyId": "dc-coit", "actionId": "dc-coit:close-dampers" }`: the operator runs one planned action on one building. It is marked `done` and `portfolioImpact.summary.usdAtRiskAfterActions` drops. Idempotent; unknown ids are ignored with a server log line.
  - `{ "type": "lookupAddress", "address": "…" }`: start an address lookup (same as `POST /incident/address`).
  - `{ "type": "confirmBuilding", "buildingId": "osm:way:123" }`: confirm a candidate (same as `POST /incident/building`).
  - `{ "type": "useDemoBuilding" }`: back to the demo building, incident cleared.
  - Live mode only; in mock mode the three lookup events are ignored with a `building` log line.

### State fields for drawing
- `rooms[]`: `{roomId, fire, smoke}`, each 0..1, at `simMinute`.
- `origin`: `{roomId, confidence}`, the likely fire room.
- `exits[]`: per occupied floor, `{floor, people, flags, stair, blockedAt, atRiskAt, route}`. `route` is the list of rooms to light green: hall → clear stairwell → down to floor 1.
- `recommendation`: pending actions for the commander. On `acceptRecommendation` it moves to `accepted: {recommendation, time}`, so keep the route lit while `accepted` is set.
- `dispatches[]`: `{roomId, time}`.
- `trail[]`: agent tool calls `{tool, input, output, ms}`.
- `reports[]`: each `{id, caller, text, roomId?, confidence?, time, reply?, channel?, incidentId?}`. `reply` is what FireSight told that caller (follow-up question or advice), so a console can show "caller said / FireSight replied" transcripts. `channel` is `voice` for phone calls. `incidentId` is the map incident the report belongs to.
- `building`: `{id, name, version, layoutEstimated}` of the active building; `buildingLookup`: the address lookup (see [Building from an address](#building-from-an-address-live-mode)).
- `log[]`: a ready-made incident log, `{time, kind, text, incidentId?}` (`incidentId` when the entry is about a map incident), where `kind` is report, origin, recommendation, accepted, dispatch or building (replies to callers are logged as `report` entries starting "Replied to"). Last 200 entries.

## Phone calls (Photon → ElevenLabs → FireSight)

```
judge's phone -> Photon number -SIP-> ElevenLabs voice agent (speech-to-text, talking, text-to-speech)
                                         | webhook tools report_address {address, caller}, report_fire {text, caller}
                                         v
                tunnel -> POST /voice/address -> building lookup (the console operator confirms the outline)
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

### `POST /voice/incident`
The webhook tool `report_incident`: any emergency, placed on the map as `state.mapIncidents[]` (shared/types.ts `MapIncident`). Same auth as `/voice/report`.

- **Body:** `{ type: "fire"|"crash"|"flood"|"other", address, description, what?, in_building?, severity?, lanes_blocked?, caller? }`. `description` is required. An unrecognized `type` becomes `other`, and an `other` report whose words say flood, water main, burst pipe, storm drain or sewer overflow becomes `flood`; unrecognized `severity` or `lanes_blocked` become `unknown`.
- **Answer:** always 200 once authorized: `{ ok, reply, incidentId, status }`. `reply` is what the voice agent says. It waits at most 4 s for the geocoder, so `status` may still be `locating`.
- **One emergency, one incident:** a report joins an existing incident of the same kind from the same caller in the last 30 minutes, at the same stated address, or within 150 m once geocoded. A sole caller giving a different address moves the pin. A resolved incident is never joined: a new report there opens a new incident. For `other`, a report that names a `what` joins only the same (normalized) label; one with no `what` can still attach.
- **Phases:** `phase` starts `open` and moves by `dispatchIncident` and `setIncidentPhase`. Resolved incidents stay in `mapIncidents`, and their pending recommendation is cleared. Over 50 incidents, the oldest resolved go first.
- **Recommendations:** each incident has its own `recommendation`, which moves to `accepted` when the operator accepts it. The newest also fills the global `state.recommendation` (the same object), unless a building's plan is showing.
- **Forecasts** run in the background (`forecastStatus`). `fire` has wind-driven fire and smoke areas and nearby building exposures. `crash` has congestion segments by minute. `flood` has water polygons by minute. `other` has none. Forecasts are modeled: `assumptions` must be shown with them. `forecastAt` is when the current one was built.
- **Refresh:** located, unresolved fires and crashes re-run their forecast every 5 minutes. The previous forecast and `forecastStatus` stay until the new one is ready, a failed refresh changes nothing, and a pending recommendation is updated silently (an accepted one is left alone).
- `reports[].reply` on the incident and on `state.reports[]` keeps what the caller was told. The responder brief uses only `query` (the stated location) and `reports[].text` (caller words); it excludes replies, forecasts, inferred fields, recommendations, dispatch records, and operator notes.
- **Voice follow-ups:** use the current ElevenLabs system prompt in [DEMO.md](../DEMO.md#phone-calls-elevenlabs). Report what happened and where immediately, then ask one short question at a time about missing details such as people hurt or trapped, floor/room, hazards, or access. Submit each caller answer through `report_incident`; preserve uncertainty and corrections, and never fill missing answers with guesses.
- **Data sources:** Geoapify (geocoding, and routes and places when Overpass is down), Overpass (roads and building outlines, first choice), Open-Meteo (wind, no key).
- A fire with `in_building: true` also starts the building lookup, exactly like `/voice/address`. A follow-up can identify an existing fire as inside a building. When separately geocoded calls merge, the surviving incident keeps the highest reported severity, any building-fire flag, and explicit lane-blockage updates; building lookups use that incident's address so the console can associate its tools correctly.

### `POST /map-incidents`
The same body and behavior as `/voice/incident` (`type`, `what`, `address`, `description`, `severity`, `lanes_blocked`, `in_building`, `caller`), without the voice token, for the console and for testing. Reports are `channel: "console"`. One operator types many reports, so only the same place ties a console report to an earlier incident, never the caller. Answers `{ ok, incident, reply }`, or 400 with `errors` when `description` is missing.

### Portfolio impact (CBRE)
Every fire, crash and flood that is placed on the map is joined with the building portfolio ([server/src/portfolio/portfolio.ts](src/portfolio/portfolio.ts): 8 synthetic buildings with systems and their dependencies, leases with SLA penalty per hour, occupancy by time of day, and access roads). After every change the server re-assesses it, in the impact agent ([agent/core/impact](../agent/core/impact)), and writes the result into the state. All fields are optional and additive.

- `portfolioImpact` (on the state): `{ properties[], summary, briefing, mode, trail?, time }`.
  - `summary`: `{ buildings, people, usdAtRisk, usdAtRiskAfterActions, horizonMinutes, headline }`. `headline` is ready to print: "6 buildings · 1,240 people · ~$380K at risk in the next 30 min". `usdAtRiskAfterActions` is what is still at risk once the executed actions are counted; this is the number that drops on Execute.
  - `properties[]`: every building any incident reaches, highest cost first. Each has `risk`, `people`, `downtimeHours`, `cost {slaUsd, lostRentUsd, damageUsd, totalUsd}`, `accessCut`, `reasons[]`, `incidentIds[]` (a building hit by two incidents appears once), `chain[]` (the failure chain in time order: `{id, minute, systemId, label, hazard, causedBy}`), and `actions[]` (ordered by deadline: `{id, text, deadlineMinute, prevents, savesUsd, reason, status: "pending"|"done"}`).
  - `mode`: `rules` (deterministic, instant) or `llm` (Nemotron ran the tools; `trail[]` is its tool calls, for the agent trail). The rules answer lands first; the Nemotron answer replaces it a few seconds later when `NVIDIA_API_KEY` is set.
- On each map incident: `impact` `{center, radiusMeters, stretch?, reasons[]}` (the blast radius to draw; `stretch` lengthens it downwind or downstream), `affectedRoads[]` (red road sections `{path, road, reason: "crash"|"flood"|"closure", fromMinute}`; draw those with `fromMinute` <= the forecast minute), `affectedProperties[]` (its slice of `portfolioImpact.properties`), `flood` (`{steps: [{minute, water: ring}], summary, assumptions}`).
- **Linking:** same kind within 150 m is merged into one incident (several calls). A different kind within 500 m is kept separate and linked: `related` is the ids of the linked incidents, nearest first, and `zoneId` is shared by every incident in the same cluster. Draw a dashed line between linked incidents.
- **Access cut:** `affectedProperties[].accessCut` is true when every road a building is reached by is red. Road names are matched by core name, so "W Campbell Rd" and "West Campbell Road" are the same road.
- **Without the agent:** if `agent/` can't be loaded the server logs why and runs on; `portfolioImpact` is then absent and everything else works.
- `npm run demo:cbre -w server` plays fire, then crash, then flood, then Execute against a running server (`SERVER_URL` to point it elsewhere).

### `POST /voice/address`
The webhook tool `report_address`: the caller said the building's address. Same auth as `/voice/report` (503 without `VOICE_TOKEN`, 401 with a wrong token).
- **Body:** `{ "address": "<the address as heard>", "caller": "<caller's number>" }` (`caller` optional).
- **Response:** starts the lookup and answers at once: `{ "ok": true, "reply": "Thank you, I have the address. Which floor is the fire or smoke on, and which room?" }`. An empty (or under 3 characters) address gives `{ "ok": false, "reply": "What is the address of the building?" }`. In mock mode the lookup is ignored but the same reply is returned with `ok: false`.
- Until the operator confirms the building, `/voice/report` replies "Help is on the way. We are confirming the building now. Do not use the elevator."; those reports are located after activation.

### Setup checklist
1. **Server:** `AGENT=1 MOCK=0 VOICE_TOKEN=<long random string> npm run dev` (`AGENT_TIMEOUT_MS` defaults to 12000). Or `npm run demo` with `VOICE_TOKEN` and `GEOAPIFY_API_KEY` in `.env`.
2. **Tunnel:** `npx -y cloudflared tunnel --url http://localhost:8080` gives `https://<name>.trycloudflare.com`. The URL changes when the tunnel restarts; update the tool URL then.
3. **Photon:** a purchased (voice-capable) number; Voice page → SIP profile, inbound on, target `sips:sip.rtc.elevenlabs.io:5061` (TLS).
4. **ElevenLabs → ElevenAgents:** create an agent.
   - First message: "FireSight. What is the address of the building?" (or keep "Where is the fire or smoke?" for demo-building calls)
   - System prompt: ask for the building's address and call `report_address` with exactly what the caller said, then read its `reply`; ask where the fire or smoke is; say "One moment, locating you" and call `report_fire` with exactly what the caller said; read the tool's `reply` back word for word; if the reply is a question, ask it and call the tool again with the answer; never give your own evacuation advice.
   - Tool `report_fire` (webhook): `POST https://<tunnel>/voice/report`, header `x-firesight-token`, body `text` (string, what the caller said) and `caller` (the caller's number from ElevenLabs' system dynamic variable, likely `system__caller_id`; check their docs), timeout 20 s (above the server's `AGENT_TIMEOUT_MS`, default 12 s).
   - Tool `report_address` (webhook): `POST https://<tunnel>/voice/address`, header `x-firesight-token`, body `address` (string, the address as the caller said it) and `caller` (as above), timeout about 10 s. It returns immediately.
   - Link the agent to the Photon SIP number.
5. **Test:** `curl -XPOST https://<tunnel>/voice/report -H 'x-firesight-token: <token>' -H 'content-type: application/json' -d '{"text":"smoke in the break room on 7","caller":"+15555550100"}'`, then the ElevenLabs in-browser test call, then a real phone.

## Control

| Endpoint | Does |
|---|---|
| `GET /health` | `{ ok, mock }` |
| `POST /live/reset` | Clears the incident: no fire, no reports, back to the demo building, no address lookup. Also stops a running demo. |
| `POST /incident/building/demo` | Live mode: back to the demo building (clears the lookup and the incident). |
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
