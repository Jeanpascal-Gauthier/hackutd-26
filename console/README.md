# FirstSight dispatch console

Run `npm run dev` from the repository root and open http://localhost:5173. The root script starts the server and the React/Vite console. On Windows, use `npm.cmd` if required by your shell.

The console retains the existing DM Sans/Space Grotesk typography, light/dark themes, color tokens, flat bordered panels, buttons, pills, and responsive layout. No new runtime dependencies are required by the incident redesign.

## Operator workflow

- Select a fire, crash, or other emergency in the incident queue. Active incidents sort by severity and then arrival time; resolved incidents remain in a separate section. New calls do not take selection away from the operator.
- Inspect the selected location on Google Maps and toggle live traffic. Street View shows existing imagery for context, not a live camera feed.
- Use situation checks, caller follow-up prompts, and responder handoff tools. Missing location, failed geocoding, and missing map credentials have explicit states.
- Review this incident's caller reports, channels, and recorded replies. Accept its recommendation, record a dispatch with an optional unit, mark on scene, resolve, or reopen it. These actions update shared server state.
- Read or copy the responder brief: the stated location and caller words, including follow-up answers. Briefs exclude forecasts, inferred details, recommendations, dispatch records, and operator notes. Copying does not send anything to responders; dispatch here records an operator action rather than contacting a CAD system or crew.
- Submit manual reports as fire, crash, or other, including location, severity, blocked lanes or whether a fire is in a building. Console reports all use `/map-incidents`.

Decisions, shared activity, agent calls, and mock reset/replay remain under Additional details. Last update is when this browser received a state snapshot. Disconnection preserves that snapshot and disables server-changing controls.

## Map configuration

Set `GOOGLE_MAPS_API_KEY` in the repository root `.env`, enable the Maps JavaScript API for the key, and restart Vite. The headset also uses this key for its Map Tiles API. This is a public browser key: restrict its referrers and enabled APIs. Server credentials such as `GEOAPIFY_API_KEY` remain on the server.

Both the console and server read environment settings from the root. The console defaults to the page's hostname on port 8080; set `VITE_SERVER_URL` to another HTTP(S) origin when needed. HTTPS uses secure WebSockets. See [.env.example](../.env.example).

Without a Google key or map connectivity, incident lists, reports, response controls, and incident tools remain usable.

## Incident tools and Nemotron

The **Incident tools** panel replaces the building-tools section. Situation checks show recorded location, severity, caller evidence, response status, and crash lane obstruction. Caller follow-up supplies type-specific questions that can be copied. Responder handoff provides the caller-only brief. Selecting another incident resets the selected tool; each tool reads only that incident's snapshot.

These are local tools, not a new Nemotron integration. The existing model agent still processes building fires; its execution trail appears only on the legacy building entry. Legacy reports and decisions remain accessible, but building lookup controls, occupancy, evacuation analysis, floor plans, and 3D models are no longer mounted in the console. Existing headset and server workflows remain separate.

See [the Nemotron tool plan](NEMOTRON-TOOLS.md) for incident triage, location review, related-report detection, scene context, adaptive follow-up, and evidence-linked handoffs, including which backend capabilities exist and which still need implementation.

## Development fixtures

Fixtures are available only in development and suppress state-changing requests:

- `?fixture=map`: fire, crash, and another incident.
- `?fixture=lookup`: a five-floor building and a lookup awaiting confirmation.
- `?fixture=tower`: a 40-floor building.
- Add `&theme=dark` or `&lookup=searching|loading|failed` where applicable.

Google basemaps still need a configured browser key. Fixtures do not establish external provider connectivity.

## Checks and handoff

```sh
npm run typecheck
npm run build -w console
npm test -w server
npm test -w agent
npm run verify -w server
npm run verify:live -w server
node --import tsx --test console/tests/incident-workspace.test.ts console/src/map/mapController.test.mjs
```

See [INTEGRATION.md](INTEGRATION.md) for the implemented frontend/backend wiring, retained functionality, and prioritized remaining work. The wire contract is in [shared/types.ts](../shared/types.ts) and [shared/events.ts](../shared/events.ts); endpoint details are in [server/API.md](../server/API.md).
