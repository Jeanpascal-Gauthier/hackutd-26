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

The primary map defaults to the 3D building; the Surroundings switch opens Google Maps in
the same workspace. Unsupported 3D automatically opens Surroundings. Caller report
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
  not zero. Geometry comes from the active building (see below); floor tabs, the 3D
  model follow every generated floor, including towers above 40 floors.
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
- The 3D building highlights the server's evacuation routes alongside fire and smoke.
  Surroundings shows geographic context without indoor route or forecast overlays.
- The themed 3D building view shares floor/room selection with the report feed and
  evacuation priorities. Selecting one of those locations returns to the 3D view.
  Theme controls, forecast playback, and new-report/log highlights are retained
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

## Incident building

`activeBuilding.tsx` starts with the bundled `shared/building.json` (the demo) and fetches
`GET /building` again whenever `state.building.id` or `version` changes; components read it
with `useBuilding()`. A new building clears the selected room and shows the fire floor (else
floor 1). When `profile.outline` is present, the 3D shell follows the footprint;
the demo, which has no outline, renders as a box building.

The Incident building panel shows the profile (name, address, use, floors, footprint, an
"Estimated layout" badge, assumptions, the latest `estimate_occupancy` basis, attribution) and
the address lookup: type an address (`lookupAddress`), follow searching/loading, confirm one of
the candidate outlines on the mini map or list (`confirmBuilding`), retry a failed lookup, or
go back to the demo (`useDemoBuilding`, after a confirmation step). The panel moves to the top
of the left column while a lookup needs attention. Lookup is disabled in the scripted demo.
Estimated people counts read "≈ 14 people" everywhere, with an "estimated" tooltip.

Dev-only fixtures (never in the production bundle, and they send nothing to the server):
`?fixture=lookup` (5-floor L-shaped building, lookup waiting for confirmation) and
`?fixture=tower` (40 floors). Add `&view=map`, `&theme=dark`, or
`&lookup=searching|loading|failed`.

## Google Maps surroundings

The Surroundings tab replaces the former floor-plan tab. `SurroundingsMap.tsx` uses the
Google Maps Embed API with street/satellite/Street View selection, recentering, fullscreen, and a link
to open the location in Google Maps. It follows the geocoded lookup as soon as a match is
available, including while awaiting building confirmation. A failed lookup shows the active
building's location instead. The synthetic demo has no geographic location and shows an
address-search prompt. Floor and forecast updates do not reload the map.
Street View first queries the Maps JavaScript API Street View service with both `google`
and `outdoor` source restrictions and a nearest-panorama preference. It searches within
150 metres, extending to 500 metres, then checks outdoor contributor imagery within 500 metres.
The outdoor filter can still return landmark interiors (reproduced with the White House and
Burj Khalifa). It is therefore not sufficient to assign the **Street View** label. Selection
also requires a nonempty location description containing a named navigation link. If centre
queries return tours without that street context, the service checks north/east/south/west
locations 200 metres away, then 350 metres away. Each group runs in parallel and selects the
closest panorama with street context, within 500 metres of the address. Its initial camera
heading faces the building.

If those searches find no street context, a tour within 50 metres of the address uses
**Interior View** for the button and iframe title. An unrestricted 50-metre search is used
only when there is no saved nearby tour. Its caption says "Indoor or unclassified panorama
near the address": this is a conservative metadata heuristic, not visual detection or proof
that imagery is indoors or belongs to the selected building. Unnamed outdoor paths may also
receive this label. The SDK supplies no reliable indoor flag. The returned panorama ID is
supplied to the Embed viewer and external link without a coordinate fallback. If no usable
imagery exists, or the service fails, a message appears and map/satellite options remain.
Provider errors do not trigger the interior fallback. Recenter repeats the selection process.
Street View is disabled without geographic coordinates.

Set `GOOGLE_MAPS_API_KEY` in the root `.env` and enable **Maps Embed API** in that key's
Google Cloud project. Street View additionally requires **Maps JavaScript API** for outdoor
panorama selection. Restart Vite after changing the key. `VITE_GOOGLE_MAPS_API_KEY` is
also accepted and takes precedence. The Vite config reads the root `.env` and exposes only
the explicitly selected Maps key from server-named variables. Google browser Maps keys are
visible to the browser: restrict this key to Maps Embed API, Maps JavaScript API and allowed website referrers
(for local development, `http://localhost:5173/*`; add LAN and hosted origins when used).
Do not reuse a privileged server key. Geoapify and NVIDIA credentials remain server-only.

If Google displays "This API is not activated on your API project", enable Maps Embed API
for the project that owns the configured key. API enablement and key restrictions are managed
in Google Cloud, not by the app. See [Google's setup guide](https://developers.google.com/maps/documentation/embed/get-api-key).

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

HTTPS origins produce secure WebSockets. Keep server credentials out of Vite variables;
the restricted Google Maps browser key described above is intentionally public.

## Checks

```powershell
npm.cmd run test -w console
npm.cmd run typecheck -w console
npm.cmd run build -w console
```

Smoke check: replay the mock incident, inspect origin/confidence and tool details,
select a room with mouse/keyboard, submit a report, and scrub to minutes 12 and 30.
Accept and dispatch from a second client; confirm accepted actions, route segments,
dispatch history and shared log appear on the console. Refresh and verify that
history survives, then reset and verify it clears. Restart the server to check
reconnection. Test narrow/mobile layouts and disabled controls while disconnected.
