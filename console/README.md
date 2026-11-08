# FireSight console

Run `npm.cmd run dev` from the repository root, then open http://localhost:5173.
The root script starts both the server and this React/Vite app.

The console uses the current shared contract. Source changes are confined to
`console/`; no new dependencies are needed.

## Available workflow

- Read the incident summary and caller reports.
- Select a floor or report location, then inspect a room's fire, smoke, occupants,
  assistance flags, and linked-report count. Missing occupant records mean unknown,
  not zero. Geometry comes from `shared/building.json`, so a coordinated replacement
  of that file automatically supplies the new floors.
- Submit caller name and report text to `POST /ingest`. The server broadcasts the
  resulting report; the console does not invent a local copy.
- Scrub the shared timeline with `setSimMinute`. Mock mode is detected through
  `GET /health` and uses the server's 0–10 minute script. Non-mock mode offers 0–30
  minutes; simulation wiring remains the server owner's responsibility.
- Accept a recommendation with `acceptRecommendation`. This acknowledges it on the
  server; it does not dispatch crews, send a reply, or draw an evacuation route.
- Reset/replay the scripted demo using existing endpoints. These actions affect all
  clients and clear server reports.
- Read a bounded browser-session activity log. It records observed state changes
  and acceptance requests, not a durable audit history or agent reasoning.
- Recover automatically when the socket drops. Last received data stays visible;
  controls are disabled until reconnection.

## Agent handoff

`AgentTrail.tsx` implements a tool-activity list with running/completed/failed
states and an empty state. It currently receives no steps because
`shared/events.ts` exposes only incident state, with no tool-call trail.

The exported `AgentStep` interface is a console presentation prop, **not an agreed
wire format**. Once B/C and the team agree on tool-call events in `shared/`, adapt
those events in `useIncident.ts` and pass the actual steps to `AgentTrail` in
`App.tsx`. No mock tool calls are displayed as agent output. Exit-route geometry
and durable action history similarly need an agreed server contract.

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

Manual smoke check: connect to the mock server, replay, select a room with mouse
and keyboard, submit a report, scrub time, accept a recommendation, and reset.
Confirm a second client observes the same changes, and restart the server to
check reconnect behavior. Test a narrow/mobile viewport and disconnected controls.
