# FireSight server API

One port (default `8080`) serves both HTTP and the WebSocket. All bodies are JSON. CORS is open.

`npm run dev` starts **mock mode**: scripted calls replay through the real model. `MOCK=0 npm run dev` starts **live mode**: it waits for real reports. Both modes support every endpoint below.

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
- `log[]`: a ready-made incident log, `{time, kind, text}`, where `kind` is report, origin, recommendation, accepted or dispatch. Last 200 entries.

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
