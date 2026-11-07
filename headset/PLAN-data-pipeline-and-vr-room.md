# FireSight — Caller Data Pipeline & VR Command Room

Working design doc, not yet agreed-on `shared/` contract. Extends (doesn't replace) the
"How it works" and "Agent tools" sections of the main project plan. Decisions below were
made 2026-11-07 while scaffolding the headset app; flag anything the full team wants to
change before it goes into `shared/types.ts`.

## 1. Call intake & classification

The call center line (Photon) receives all kinds of emergencies, not just fire. Two filter
passes happen before anything reaches the simulation:

1. **Is it fire-related at all?** A cheap first classification on the raw call/text. Not
   fire-related → outside FireSight's scope, no further processing (in a real deployment this
   would route back to normal dispatch; for the demo we just never see those calls, since the
   demo number only exists for this scenario).
2. **Which category(ies) does it contain?** One call can contain more than one signal — a
   single sentence like *"smoke in the break room on 7, I can hear people coughing in the
   hallway"* produces **two** signals, not one.

### Category taxonomy (v1 — core four, decided to avoid new `shared/` schema fields)

| Category | What it captures | Resolves to |
|---|---|---|
| `fire_sighted` | Caller directly reports flames | `roomId` |
| `smoke_sighted` | Caller reports smoke or burning smell | `roomId` |
| `occupant_sighted` | People present, trapped, injured, or in distress (includes "I hear coughing/screaming" — sound is folded in here as supporting detail, not its own category) | `roomId` |
| `exit_status` | A stairwell/door/elevator reported as blocked, smoky, or clear | `verticalId` or `linkId` |

Explicitly deferred for v1: a separate `hazard` category (gas smell, structural damage,
electrical) and a separate `sound` category. Both would need new fields in
`shared/building.json` / `shared/types.ts`, which is the one file everyone has to agree on in
hour one — not worth the coordination cost for the hackathon. Hazard/sound detail still gets
captured as free text inside a report's body (see below), it just doesn't get its own icon or
schema field yet.

### Storage shape: header (fast index) + body (full detail)

Every extracted signal becomes one **report**, split into a small header (what the UI scans
constantly) and a body (loaded on demand — transcript, reasoning trail).

```ts
// header — kept in the live incident state, broadcast over the WebSocket
interface ReportHeader {
  reportId: string;
  callId: string;            // groups signals extracted from the same call/text
  receivedAt: string;        // ISO timestamp
  category: "fire_sighted" | "smoke_sighted" | "occupant_sighted" | "exit_status";
  roomId: string | null;     // null until locate_room resolves it
  verticalId: string | null; // only set for exit_status reports
  confidence: number;        // 0–1, from locate_room / merge_reports
  status: "new" | "merged" | "superseded" | "needs_followup";
  severity: "info" | "elevated" | "critical";
}

// body — fetched by reportId, not pushed on every state update
interface ReportBody {
  reportId: string;
  rawTranscript: string;
  channel: "voice" | "sms" | "form";
  callerPhoneMasked: string;        // last 4 digits only
  extractedFields: Record<string, string>; // e.g. { smokeDensity: "heavy", note: "coughing heard" }
  agentReasoning: string[];         // tool-call trail entries (this is what Nvidia judges see on the console)
  followupAsked: string | null;
  followupAnswer: string | null;
}
```

### Worked example

Caller says: *"There's smoke coming from the break room on the 7th floor, and I can hear
people coughing in the hallway outside."*

`locate_room` extracts two reports from one call:

```json
{
  "reportId": "r-0091", "callId": "c-0042", "receivedAt": "2026-11-08T01:12:04Z",
  "category": "smoke_sighted", "roomId": "7-break", "verticalId": null,
  "confidence": 0.86, "status": "new", "severity": "elevated"
}
```
```json
{
  "reportId": "r-0092", "callId": "c-0042", "receivedAt": "2026-11-08T01:12:04Z",
  "category": "occupant_sighted", "roomId": "7-hall", "verticalId": null,
  "confidence": 0.62, "status": "new", "severity": "elevated"
}
```
Body of `r-0092`: `extractedFields: { "note": "coughing heard, count unconfirmed" }` — the
"sound" detail lives here as text, not as a schema field.

## 2. AI correlation (`merge_reports`)

Two stages, matching the tools already in the plan:

1. **Per-report** (`locate_room`): resolve category + room/vertical + confidence, write
   header + body, broadcast the new report over the WebSocket immediately (this is what makes
   the "ping" land live on the model — see §4).
2. **Incident-level** (`merge_reports`, re-run on every new report): cluster all current
   reports by building adjacency (same room, same floor, or linked rooms within the fire/smoke
   graph). For the demo there's one building, so there's one cluster. Per cluster:
   - Pick the highest-confidence `fire_sighted`/`smoke_sighted` report as the likely origin.
   - Sum `occupant_sighted` counts into a live at-risk total, kept **separate** from the
     static `occupants` array already in `building.json` — a caller-reported person is more
     urgent and less certain than a known badge-in occupant, and the UI should show the
     difference (see §4).
   - Fold `exit_status` reports into the exit finder as overrides/corroboration of the
     computed stairwell-clear state, flagging disagreement rather than silently trusting
     either side (same philosophy as the plan's existing answer to "agent picks the wrong
     room" — show confidence, don't guess silently).

This cluster becomes the `run_spread` input (origin + start time), exactly as in the existing
plan — nothing about the spread model itself changes.

## 3. Visual mapping (data category → VR representation)

| Category | In the model | Notes |
|---|---|---|
| `fire_sighted` / `smoke_sighted` | Room fire/smoke color overlay (already planned) + a brief ripple/flash at the room when the report first lands | Steady-state color still comes from the spread model, not the raw report |
| `occupant_sighted` | Pulsing icon, distinct style from static `building.json` occupants | Distinguishes "reported live, uncertain" from "known in advance" |
| `exit_status` | Overrides/corroborates stairwell clear/smoky fill; small conflict icon if it disagrees with the computed state | Never silently overrides the model |

## 4. VR command room layout

Hexagonal room, commander seated **dead center**. The desk in front has **three zones**,
matching the hex room's natural wall facets:

- **Left zone (near-field, within pinch/reach distance):** the glass building model. This
  replaces the original plan's "model sits on the desk in front" — it now sits to the left so
  the center stays clear for hand gestures and passthrough registration. Pinch-floor,
  pinch-room interactions from the original plan are unchanged, just relocated left.
- **Center (far-field, wall-mounted, straight ahead beyond the bare desk):** the voice/comms
  screen (§5).
- **Right zone (far-field, wall-mounted):** the Resources & People panel (§6).

**Generation cap:** the model renders the current incident building at full detail (matches
`building.json`, 12 floors). If scope ever grows beyond one building, apply priority
rendering: full detail only for the origin building and any floor with an active report;
everything else renders as a simplified low-poly placeholder until it gets a report of its
own. Not needed for the hackathon's single-building demo, but worth building this way from
the start so it doesn't need a rewrite later.

## 5. Center screen: voice/comms panel

**Layout:** screen divided into 4 quadrants (upper-left, upper-right, lower-left,
lower-right). 1–4 participants → one box per quadrant. 5–8 participants → each quadrant
splits into a stacked pair. Max 8 total, neat and non-overlapping at every count.

**Two participant types, visually distinct:**

- **Caller boxes** (911 callers, blue border): animation is driven by **real-time audio
  level**, not a text pulse. Cheapest way to get this without piping raw audio into the
  headset: the server extracts just the audio level from the inbound Photon voice stream
  (~10–20 Hz) and broadcasts that single number per `callId` over the existing WebSocket —
  no WebRTC/audio streaming into the Quest needed, just a time series of floats driving a
  pulsing ring, same visual idea as Discord's speaking indicator. Box icon also flashes amber
  briefly whenever a new structured report lands from that caller, tying the voice panel back
  to the data pipeline.
  - **Risk:** the main project plan already flags that Photon voice/transcription support is
    unconfirmed. If voice doesn't pan out by the 7AM Sunday feature freeze, the same box
    falls back to a text-arrival pulse instead of an audio-level pulse — same visual slot,
    cheaper driver, no UI rework needed. (This mirrors the plan's existing "voice calls only
    if text has been solid" line item — not a change to what you asked for, just the documented
    fallback if the audio path doesn't land in time.)
- **Firefighter boxes** (simulated, red/amber border): no real audio. A unit appears the
  moment a recommendation is accepted and a unit is dispatched — same event that already
  lights the evacuation route green in the original plan. Label shows unit name + status
  ("Engine 3 — en route" → "on scene"), status auto-advances on a timer in the scripted/mock
  incident (Person B's mock mode already replays a scripted incident, so this timer slots into
  that). No new live channel, no second Photon line.

## 6. Right screen: Resources & People

Minimal, large-type panel — not a data dump, just the numbers the 3D model can't show well:

- Units: **Dispatched / En route / On scene** counts (mirrors the firefighter boxes above,
  as a compact summary rather than duplicating the live boxes).
- **People at risk** — one aggregate number: live `occupant_sighted` reports + at-risk floors
  from `find_clear_exits`, not a per-room breakdown (that's what pinching a room on the model
  is for).

Deliberately does **not** duplicate the incident log or agent reasoning trail — those stay on
the laptop console (Person D), which is already the plan for where Nvidia judges look to see
the agent's tool-call trail.

## 7. Who owns what (mapped onto the existing work split)

- **B (Server & simulation):** report header/body storage, `merge_reports` clustering,
  audio-level extraction + broadcast over WebSocket, firefighter dispatch-status timer in mock
  mode.
- **C (AI & calls):** extend `locate_room` to emit the core-four categories per call, not just
  a single room id.
- **A (Headset):** hex room layout, left-zone model relocation, center voice-panel grid
  (quadrant/8-box layout, two box styles), right-zone resources panel, report-arrival ripple
  effect on the model.
- **D (Console & pitch):** no change to existing scope — still owns the incident log/reasoning
  trail on the laptop.

## 8. Open items

- Confirm with Photon docs (per the main plan's existing action item for C) whether raw audio
  or an audio-level stream is accessible server-side at all — this gates whether §5's
  real-time caller animation is buildable, independent of transcription support.
- `merge_reports` clustering logic above assumes one building; fine for the demo, flagged in
  §4 as the place to extend later if CBRE judges ask about multi-building scale.
