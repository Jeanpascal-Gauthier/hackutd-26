# FireWatch console

Run `npm.cmd run dev` from the repository root, then open http://localhost:5173.
The root script starts both the server and this React/Vite app.

The console uses the current shared contract. Source changes are confined to
`console/`; no new dependencies are needed.

## Available workflow

The dispatch screen prioritizes suspected origin, people at risk, stair smoke
concerns, next actions, and evacuation priorities. Risk totals cover the whole
30-minute model forecast, not only the currently selected minute. Missing analysis
is displayed as pending rather than zero risk.

The primary map defaults to the 3D building; the floor-plan switch replaces it in
the same workspace. Unsupported 3D automatically returns to the floor plan. Caller report
entry stays visible. The feed initially shows the latest three complete reports,
with a control to reveal all reports and explicit uncertain-location labels.

Detailed forecasts, shared activity/decisions, agent calls, and demo reset/replay
controls start collapsed under Additional details. Their summaries show counts.
The latest pending or accepted recommendation stays visible in Next actions,
including when another client accepts it. The full decision history remains
available under Activity & decisions.

The header labels the selected forecast minute and offers a return to minute 0.
Last update is the time this browser received state. Disconnection keeps the last
snapshot visible with an alert and disables state-changing controls. The default
theme is light, with saved light/dark choices respected.

- Read the incident summary and caller reports.
- Select a floor or report location, then inspect a room's fire, smoke, occupants,
  assistance flags, and linked-report count. Missing occupant records mean unknown,
  not zero. Geometry comes from `shared/building.json`, so a coordinated replacement
  of that file automatically supplies the new floors.
- Submit caller name and report text to `POST /ingest`. The server broadcasts the
  resulting report; the console does not invent a local copy.
- Scrub the shared 0–30 minute forecast with `setSimMinute`, in both mock and live
  modes. Mock mode is detected through `GET /health`: scripted reports run through
  the real spread model. Scrubbing changes forecast conditions; scripted callers
  are delivered on replay ticks, not re-created when you move the slider backward.
- Read `origin` and its confidence, plus `exits` for each occupied floor: people,
  assistance flags, recommended stair, and predicted floor/stair smoke threshold
  times. Times are absolute forecast minutes, not minutes remaining from the slider.
- Accept a pending recommendation with `acceptRecommendation` as the commander
  backup control. The server moves it to `accepted`, including the server time.
  Acceptance from another client is also shown. The wire format does not identify
  the actor or whether it was manual, so the console never labels it human approved.
- Forecast route segments use dashed green outlines; accepted segments become solid
  and draw on once when acceptance arrives, while retaining hazard colors.
  Only rooms with known fire <= 0.01 and smoke < 0.3 are marked at the selected
  minute; this is a visualization of the server route, not a new route calculation.
- The themed 3D building view shares floor/room selection with the 2D map and report
  feed. Theme controls, forecast playback, and new-report/log highlights are retained
  alongside the detailed server panels. Playback pauses on reset, replay, disconnect,
  or manual scrubbing. Three.js is provided by the merged console dependencies.
- Read `dispatches` as destinations/times and click a destination to inspect it.
  The console does not invent unit names, travel states, or crew arrival times.
- Reset/replay the scripted demo using existing endpoints. These actions affect all
  clients and clear server reports.
- Read `state.log` as the shared incident history, newest first, including activity
  recorded before this browser connected. It survives browser refresh/reconnection
  while the server incident is alive; server resets clear it. Connection state is
  shown in the header rather than mixed into the server log.
- Recover automatically when the socket drops. Last received data stays visible;
  controls are disabled until reconnection.

## Agent activity and remaining handoffs

`AgentTrail.tsx` consumes shared `TrailStep` values directly from `state.trail`, in
execution order, with expandable input/output and recorded milliseconds. A call
whose output contains an error is marked accordingly. The contract has neither
call timestamps nor in-progress events; the UI does not manufacture either.

In mock mode the trail explains that entries/timings may be illustrative. The
server can use either a real agent or its rule-based processor, and mock replay
adds illustrative steps when an agent trail is unavailable. An empty trail means
no calls were recorded, not that the server is disconnected.

The headset currently auto-accepts recommendations and sends dispatch events.
Manual commander approval is a handoff to the headset owner. This console shows
what the server recorded without claiming the source of acceptance. Its backup
Accept button acknowledges only; it does not send a caller reply or dispatch a crew.

## Server address

By default the console contacts the page's hostname on port 8080. For another
server, set Vite's `VITE_SERVER_URL` to an HTTP(S) origin before launching Vite:

```powershell
$env:VITE_SERVER_URL = 'http://localhost:8080'
npm.cmd run dev -w console
```

HTTPS origins produce secure WebSockets. Do not put API keys in Vite variables.

## Checks

```powershell
npm.cmd run typecheck -w console
npm.cmd run build -w console
```

Smoke check: replay the mock incident, inspect origin/confidence and tool details,
select a room with mouse/keyboard, submit a report, and scrub to minutes 12 and 30.
Accept and dispatch from a second client; confirm accepted actions, route segments,
dispatch history and shared log appear on the console. Refresh and verify that
history survives, then reset and verify it clears. Restart the server to check
reconnection. Test narrow/mobile layouts and disabled controls while disconnected.
