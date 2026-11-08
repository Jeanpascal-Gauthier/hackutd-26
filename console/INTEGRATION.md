# Multi-incident redesign handoff

The interrupted Claude work was recovered from the local session and agent assignments. Its four implementation areas were the console shell/panels, Google Maps components, server incident lifecycle, and fire/crash model upgrades. The continuation preserves that implementation and checks the combined result.

## Retained

- Existing fonts, color tokens, light/dark themes, borders, panel structure, button/pill patterns, responsive breakpoints, and reduced-motion behavior.
- Shared WebSocket state, reconnect behavior, connection status, shared activity, caller replies, agent trail, and mock reset/replay.
- Legacy building reports and decisions remain accessible. Building lookup controls, occupancy, evacuation analysis, floor plans, and 3D models are no longer mounted in the console.
- Compatibility with existing building-only agent and headset clients. Their code and workflows are not redesigned in this change.

Visible console branding is now **FirstSight** in `src/brand.ts`. Existing package identifiers, protocol headers, and theme storage keys remain compatible.

Forecast UI has been removed from the console: map playback, modeled overlays and legends, the impact tool, forecast status messages, and modeled sections in responder briefs. Server forecast contracts remain available for other clients.

## Frontend/backend connections implemented

| Frontend behavior | Contract / route | Server behavior |
| --- | --- | --- |
| Queue, pins, selected incident | WebSocket `state.mapIncidents` | Sends located and unlocated incidents with kind, severity, phase, reports, and forecast status. |
| Submit a manual incident | `POST /map-incidents` | Accepts `type`, `what`, `address`, `description`, `severity`, `lanes_blocked`, `in_building`, and `caller`; records console channel and caller reply. |
| Scope caller reports and log | `Report.incidentId`, `LogEntry.incidentId` | Associates map reports and activity with the incident. Legacy building records have no incident ID. |
| Accept selected recommendation | `acceptRecommendation { incidentId }` | Moves that incident's recommendation into its accepted record; legacy no-ID behavior remains supported. |
| Record a dispatch | `dispatchIncident { incidentId, unit? }` | Stores dispatch history and moves an open incident to dispatched. |
| On scene / resolve / reopen | `setIncidentPhase { incidentId, phase }` | Updates shared phase; resolved incidents remain available and stop refreshing. |
| Operator notes | `addIncidentNote { incidentId, text }` | Stores bounded notes on the incident, excluded from the caller-only responder brief. |
| Incident situation checks and caller follow-up | Client-side checks and incident-type question templates | Reads only the selected incident; no model request or outbound caller message. See [the Nemotron tool plan](NEMOTRON-TOOLS.md) for the proposed integration. |
| Copy responder brief | Client-side text generation and clipboard | Uses only the stated location and caller words, including follow-ups. No outbound responder messaging. |

Google Maps and Street View load directly in the browser using the public `GOOGLE_MAPS_API_KEY`. Google live traffic is distinct from the server's modeled congestion. Street imagery supplies historical context and does not prove present conditions.

## Setup still required in your environment

1. Set root `GOOGLE_MAPS_API_KEY`, enable Maps JavaScript API, and allow the console's referrer. The headset separately needs Map Tiles API.
2. Set server-side `GEOAPIFY_API_KEY` for address geocoding. The incident models use OpenStreetMap/Overpass road and building data and Open-Meteo wind; degraded provider data is reflected in model assumptions.
3. Start with `npm run dev`. For a remotely hosted console, set `VITE_SERVER_URL` before starting/building it and use a server accessible from that browser.
4. Configure the phone agent to use the already supported `/voice/incident` route for multi-type incidents, including its existing token. The legacy `/voice/report` and `/voice/address` routes remain building-fire focused. See `server/API.md` for request shapes.

## Backend improvements included

- Per-incident recommendations, acceptance, dispatch history, lifecycle, notes, and caller replies.
- Separation of differently labeled `other` incidents; new reports do not silently append to resolved incidents. Retention discards resolved incidents first.
- Periodic forecasts for active located fires/crashes, with prior forecasts retained during refresh and timers cleaned up on clear/removal/resolution. The default refresh is five minutes; service options can change or disable it.
- Sensitive-site lookup out to about 3 km, alongside nearby buildings; weather/data limitations remain explicit. Sensitive-site lookup failure does not discard ordinary building data.
- Crash clearance assumptions and nearby alternate-road candidates, with no claim to live capacity or validated navigation.
- Rounded overlay coordinates and coalesced WebSocket broadcasts (default 100 ms, configurable with `WS_BROADCAST_MS`). New clients still get an immediate snapshot.

## Prioritized next backend work

| Priority | Work | Frontend benefit |
| --- | --- | --- |
| 1 | Add multi-type triage and incident tools to the Nemotron/text/QR pipelines; carry incident IDs through follow-ups. | Every intake channel feeds the same queue instead of remaining building-fire only. |
| 1 | Add an incident-ID update/location-correction endpoint and connect a selected-incident report mode. | Operators can correct an unlocated manual incident directly. The current form submits new reports; matching kind/address/proximity may merge them, but it does not explicitly target an incident. |
| 1 | Give each building incident its own building/simulation context and stable owner ID. | Multiple simultaneous building fires can be inspected without competing for the one active building. |
| 1 | Persist incidents and add operator identity, permissions, and action acknowledgments/errors. | History survives server restart; the UI can identify who changed a response and confirm each action. Current state is in memory. |
| 2 | Add verified responder/CAD integration and delivery status. | Dispatch and briefs can be delivered and acknowledged rather than only recorded/copied. |
| 2 | Add current observations, source timestamps/confidence, photos or authorized camera feeds. | Operators can distinguish current on-scene evidence from caller reports, historical imagery, and forecasts. |
| 2 | Calibrate fire/smoke and traffic models; model queue discharge in time steps and segment visibility. | Forecasts can reflect suppression, reopening, rerouting, and changing conditions. The server model currently keeps crash queues growing through 30 minutes even when an earlier reopening is assumed. |
| 3 | Add delta/subscription updates and forecast geometry caching. | Many simultaneous incidents can update efficiently; coalescing still transmits full snapshots. |
| 3 | Extend the headset contract and UI for geographic incident selection. | Immersive multi-incident views can follow the console. The existing headset remains building focused. |

Additional incident kinds currently use caller information and a map pin. They do not acquire a crash or fire forecast merely by being classified as `other`.

## Continuation verification

- All workspace typechecks and the production console build pass. The build retains a large-chunk warning for the existing heat-field renderer.
- 208 server tests, 140 agent regression tests, and 13 console/map regression tests pass.
- Existing mock and live integration verifiers pass, including shared building state, acceptance, dispatch, reconnection, and resets.
- Server integration coverage includes manual map reports through HTTP, WebSocket caller records/replies, response actions, notes, recommendation acceptance, resolution, and a reconnecting client's snapshot.
- Maps tests use API doubles to check incident pin reuse, omitted forecast overlays, location changes, camera preservation, traffic toggling, and cleanup without a Google key.
- Live Google basemap/Street View rendering and responsive browser interaction were not exercised. The local Paradev browser CLI is not signed in; provider credentials/connectivity were not independently validated.
