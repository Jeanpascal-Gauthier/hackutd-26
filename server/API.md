# FireSight server API

One port (default `8080`) serves both HTTP and the WebSocket. All bodies are JSON. CORS is open.

`npm run dev` starts **mock mode**: scripted calls replay through the real model. `MOCK=0 npm run dev` starts **live mode**: it waits for real reports. Both modes support every endpoint below.

## For the agent (runs as its own process)

The agent never imports server code. Its tools call these endpoints:

| Agent tool | Endpoint |
|---|---|
| `locate_room` | `GET /building` (room ids, names, floors) and the agent's own reasoning |
| `merge_reports` | `GET /state` → `reports`, `origin` (the server also merges) |
| `run_spread` / `find_clear_exits` | `POST /forecast` |
| `write_recommendation` | `POST /forecast` → `recommendation` is a draft to improve |
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
`{ building, occupants, sprinklers }`
- `building` is `shared/building.json`.
- `sprinklers` maps room id → `active` | `impaired` | `none`.

## For the headset and console (WebSocket)

- **Server → client:** `{ "type": "state", "state": IncidentState }`. Sent on connect and after every change.
- **Client → server:**
  - `{ "type": "setSimMinute", "minute": 0..30 }`: scrub the forecast for everyone.
  - `{ "type": "acceptRecommendation" }`
  - `{ "type": "dispatch", "roomId": "7-break" }`: logged only, for now.

## Control

| Endpoint | Does |
|---|---|
| `GET /health` | `{ ok, mock }` |
| `POST /live/reset` | Clears the incident: no fire, no reports. Also stops a running demo. |
| `POST /mock/replay` | Mock mode: restart the scripted demo. |
| `POST /mock/reset` | Mock mode: stop, minute 0. |
