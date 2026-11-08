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
append `?server=https://your-server-host` to the headset app URL. A production
host must provide the same proxy paths or use that HTTPS server override.

For Quest over USB, authorize the device and forward the app port:

```sh
adb devices
adb -s YOUR_DEVICE_SERIAL reverse tcp:8081 tcp:8081
```

Open `https://localhost:8081/` in Quest Browser and enter VR. Reuse the existing
app tab for later reloads so there is only one headset tab. The experience uses
an opaque virtual room rather than physical-room passthrough.

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
```

Run these inside `headset/`; the root workspace typecheck does not include it.

## Current prototype behavior

Reports, room hazards, evacuation routes, and people-at-risk totals come from
the real incident server. Room heights are a display assumption of 3.5 metres;
room footprints come from `/building`.

A new recommendation automatically sends dispatch and acceptance events to the
shared server. There is no manual commander approval control yet. Engine 3's
progress from dispatched to en route to on scene is simulated locally; it is
not real crew tracking. This app therefore changes the shared incident when
running against it. Use a demo server when trying the prototype independently.

`iwsdk.config.json` selects the scene and VR features. `src/assets.ts` registers
models and panels. Scene composition lives in
`public/scenes/main.iwsdk.scene.json`; application systems are registered in
`src/index.ts`.
