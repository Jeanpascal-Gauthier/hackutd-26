# Map view: console handoff

For Person D. The server now publishes every emergency with its forecast. The console needs a Google Maps panel to show them. Nothing here changes existing panels, and the new field is optional, so the console keeps working until this ships.

## What you get

`state.mapIncidents` arrives on the existing WebSocket `state` event. The types are `MapIncident` and its children in `shared/types.ts`.

| Field | Use |
|---|---|
| `kind`, `label`, `severity` | Pin icon and title |
| `status` | Only `located` has a `location`. Show the others in a list as "Locating" or "Location needed", with `query` |
| `reports[]` | Caller words, for the pin's detail card |
| `forecastStatus` | `running`: show a spinner. `failed`: keep the pin and say the forecast is unavailable |
| `fire`, `crash` | Overlays, below |

## What to draw

Use `state.simMinute` as the forecast time, so the existing slider drives the map too. At minute 0 show pins only.

**Fire** (`incident.fire`): take the last entry in `steps` with `minute <= simMinute`.
- Draw `step.smoke` as a grey `google.maps.Polygon`, under `step.fire` in red.
- Draw `exposures` by `risk`. Use a polygon when `outline` has points, and a marker at `location` when `outline` is empty, which happens when OpenStreetMap is down.
- If `wind` is null, smoke is an even circle. Say that direction is unknown.

**Crash** (`incident.crash`): draw each entry in `segments` with `queueMinute <= simMinute` as a `google.maps.Polyline`.
- Color by `level`: `blocked` dark red, `heavy` red, `moderate` amber.
- Add `new google.maps.TrafficLayer()` so operators can compare the forecast with live traffic.
- `steps` gives queue length and affected roads per minute, for a side panel.

**Other** kinds are pins only.

Always show `summary` and `assumptions` with a forecast, and label it as modeled. Commanders will relay this to crews, so it must not read as observed fact.

## Setup

- No new dependency is needed. Load `https://maps.googleapis.com/maps/api/js?key=...&v=weekly` with a script tag.
- Add `VITE_GOOGLE_MAPS_API_KEY` to the root `.env` and `.env.example`, and check that Vite reads the root folder (`envDir`) in `console/vite.config.ts`.
- This key ships to the browser. Restrict it by HTTP referrer in Google Cloud and enable only the Maps JavaScript API.

## Try it without a phone

With the server running in live mode and `GEOAPIFY_API_KEY` set:

```sh
curl -XPOST localhost:8080/map-incidents -H 'content-type: application/json' \
  -d '{"type":"crash","address":"Campbell Road and Coit Road, Richardson, TX","description":"two cars crashed","lanes_blocked":"all","caller":"test-1"}'
curl -XPOST localhost:8080/map-incidents -H 'content-type: application/json' \
  -d '{"type":"fire","address":"800 W Campbell Rd, Richardson, TX","description":"grass fire by the parking lot","caller":"test-2"}'
curl -XPOST localhost:8080/map-incidents -H 'content-type: application/json' \
  -d '{"type":"other","what":"gas leak","address":"7 Dallas Pkwy, Plano, TX","description":"strong smell of gas","caller":"test-3"}'
```

Forecasts appear within about 15 seconds. `npm run demo:reset` clears the map.
