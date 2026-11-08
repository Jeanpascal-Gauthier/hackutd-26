# Firewatch headset

VR command room with a desk wrapping around the three front walls, a tabletop
building derived from the server's room footprints, live fire/smoke and accepted
evacuation-route overlays, caller reports, and resource statistics.

## Run locally

Install the monorepo dependencies from the repository root, then start the server:

```sh
npm install
npm run dev -w server
```

In a second terminal, install and start the headset app separately (it is not a
root npm workspace):

```sh
cd headset
npm ci
npm run dev
```

The headset dev server uses port 8081 and proxies HTTP and WebSocket traffic to
the incident server on port 8080. Keep both running. For a remote incident server,
append `?server=https://your-server-host` to the headset app URL. You can also
start the dev session with `FIREWATCH_SERVER_URL=http://host:port npm run dev`
to point its proxy at a different server. A production
host must provide the same proxy paths or use that HTTPS server override.

For Quest over USB, authorize the device and forward the app port:

```sh
adb devices
adb -s YOUR_DEVICE_SERIAL reverse tcp:8081 tcp:8081
```

Open `https://localhost:8081/` in Quest Browser and enter VR. Reuse the existing
app tab for later reloads so there is only one headset tab. The experience uses
an opaque virtual room rather than physical-room passthrough.

## Room setup

Enter VR, face the direction you want the front wall, then press **Center room here**
on the setup panel. It centers the virtual room at your current position and brings
the building within reach. **Bring building closer** resets its size and places it
in front of you without moving the room. These controls do not change the Quest
safety boundary.

## Building controls

- Hands: pinch the building with one hand to pick it up. Move or turn your hand
  to carry and rotate it; release the pinch to leave it in place.
- Pinch it with both hands, then spread your hands to enlarge it or bring them
  together to shrink it. Zoom is limited to 0.5×–3× the original model size.
- Controllers: hold the grip/squeeze button near the building. Use both
  controllers together to scale it.

The building rotates and scales around its centre, and live fire/smoke and route
updates continue while it is held. These controls manipulate the whole building;
individual floor/room selection from the plan is a separate interaction.

## Validate

```sh
npm run typecheck
npm run build
node --test tests/*.test.mjs
```

Run these inside `headset/`; the root workspace typecheck does not include it.

## Current prototype behavior

Reports, room hazards, evacuation routes, and people-at-risk totals come from
the real incident server. Room heights are a display assumption of 3.5 metres;
room footprints come from `/building`.

Recommendations wait for an operator to press **Accept recommendation**.
**Dispatch crew** sends a real dispatch event for the inferred origin room.
The connection indicator shows when state may be stale; action buttons are
disabled while disconnected. Commands are not queued for a later reconnect.
Engine 3's progression is simulated locally from the confirmed dispatch timestamp,
not real crew tracking. Incident reset clears that simulated unit.

If the server is unavailable at startup, the building fetch retries until it
returns. WebSocket connections retry after disconnect and receive the latest
shared incident state on reconnect. The transport tests include an isolated
real-server check on port 18081 and do not reset the shared demo on port 8080.

`iwsdk.config.json` selects the scene and VR features. `src/assets.ts` registers
models and panels. Scene composition lives in
`public/scenes/main.iwsdk.scene.json`; application systems are registered in
`src/index.ts`.

### FireEye briefing and 3D city

The headset now opens in FireEye. It shows a quiet briefing room and the active
building's name and coordinates. After the teammate WebSocket supplies a nonempty
`recommendation.actions` and Google tiles are ready, it waits two seconds, raises
the briefing screen, and opens the city. North/East/South/West change the viewing
side without moving the observer; Briefing returns to the room and pauses automatic
entry until Preview city is pressed. A manual preview is also available while
waiting for the agent. Manual preview stays open through connection retries. Longer recommendations are paged without dropping
text. The cyan beacon marks the selected coordinate.

Set `GOOGLE_MAPS_API_KEY` in the repository root `.env` and enable Google's Map Tiles
API for that key. Only that exact Maps key is exposed to the browser. Use
`FIREWATCH_HEADSET_PORT=8085 FIREWATCH_SERVER_URL=http://localhost:8098 npm run dev`
from `headset/` to use those ports, or omit the variables for defaults 8081/8080.
The existing command room remains at `/?view=firewatch`.

FireEye consumes the current building and recommendation contracts. Outdoor
fire/smoke forecasts and crash-related traffic forecasts still need agent/server
feeds; the map imagery itself is not live incident footage. The address
`800 W. Campbell Road` is shared by multiple UTD buildings: confirm the selected
building rather than treating the street address as a unique match.

The focused integration check uses an isolated local WebSocket fixture, leaving the
team's live incident untouched:

```sh
npx @iwsdk/cli dev up --headless --allow-browser-automation
npx @iwsdk/cli browser run tests/fire-eye-flow.mjs --timeout 90000
```

It requires an active mapped building, streams real Google tiles, and checks the
briefing, recommendation delivery, countdown, screen movement, map reveal,
attribution, texture budget and application errors. This browser check does not
establish physical Quest frame rate.

The city overview uses a 250 m elevated setback; side views use 200 m. Map textures
retain trilinear mipmaps and up to 4x anisotropic filtering. Immersive tile selection
uses both eyes together, and the aerial camera uses a 0.5–3000 m clipping range.
