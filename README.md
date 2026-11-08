# FireWatch

HackUTD '26 project. FireWatch turns reports about a fire in a multi-story building into a live 3D model that an incident commander views in a VR headset: where the fire is, where the smoke will be over the next 30 minutes, who is still inside, and which stairwell is safe. Dispatch sees the same live state on a laptop console.

## How it works

1. A person in the building texts the FireWatch line (Photon 2.0, iMessage), or fills in the QR web form: "There's smoke coming from the break room on the 7th floor."
2. A Nemotron agent calls its tools in order: `locate_room` → `merge_reports` → `run_spread` → `find_clear_exits` → `write_recommendation`. If the location is unclear, it texts the caller a follow-up question.
3. The server updates the incident and broadcasts it over WebSocket. The spread model forecasts fire and smoke room by room, minute by minute, for 30 minutes.
4. The headset (Meta Quest, passthrough) and the console re-render: a red room, smoke climbing the stairwells, people at risk, and a green evacuation route once the commander accepts the recommendation.
5. The caller gets a reply telling them which stairwell to use.

Every agent run logs its tool calls, and the console shows that trail. A human makes every decision. The building data is synthetic, and the spread model is a first estimate, not a fire simulation.

## Quick start

```sh
npm install
npm install --prefix headset   # the headset is not a workspace; it has its own lockfile
cp .env.example .env           # fill in NVIDIA_API_KEY, and the Photon keys for the text line
npm run demo                   # everything: server + agent, console, headset, QR form, Photon line
```

| What | URL |
| --- | --- |
| Console | http://localhost:5173 |
| Headset (in a browser; accept the certificate warning) | https://localhost:8081 |
| Report form / its QR code | http://localhost:8090/ and http://localhost:8090/qr |
| Server health | http://localhost:8080/health |

`npm run demo -- --mock` plays a scripted incident with no agent or API key. See [DEMO.md](DEMO.md) for the full runbook: opening the headset on the Quest, registering phones for the iMessage line, resetting between judges, and what to do if something breaks.

For development, `npm run dev` starts the server in live mode and the console, with address entry
enabled. Set `GEOAPIFY_API_KEY` in the root `.env` for building lookup, then restart the dev process.
Use `npm run demo -- --mock` for scripted calls on the demo building.

## Layout

| Folder | What it is |
| --- | --- |
| `shared/` | The contract: `types.ts`, WebSocket events (`events.ts`), `building.json` |
| `server/` | Node server on :8080: incident state, WebSocket, `POST /ingest`, spread model, exit finder, mock mode. API in [server/API.md](server/API.md) |
| `agent/` | Nemotron agent and its five tools, Photon 2.0 line, QR report form |
| `console/` | React + Vite + three.js dispatch console: 3D building, floor plan, call log, agent trail, exit analysis |
| `headset/` | Immersive Web SDK (three.js) mixed-reality app for the Quest |
| `data/` | Building generator and validator (floor plans, sprinkler and fire-door inspection records, occupancy) |

## Stack

- **AI:** NVIDIA Nemotron through NVIDIA's OpenAI-compatible API, with tool calling
- **Texts:** Photon 2.0 (`@photon-ai/api`), iMessage
- **Phone calls:** a Photon voice number forwards calls over SIP to an ElevenLabs voice agent, which asks for the address and the fire's location and calls the server's `/voice/address` and `/voice/report` tools ([DEMO.md](DEMO.md#phone-calls-elevenlabs), [server/API.md](server/API.md#phone-calls-photon--elevenlabs--firesight))
- **Address lookup:** Geoapify geocoding plus OpenStreetMap building outlines (`GEOAPIFY_API_KEY`)
- **Headset:** Meta Immersive Web SDK, running in the Quest browser over HTTPS
- **Console:** React, Vite, three.js
- **Server:** Node + TypeScript, HTTP and WebSocket on one port

## Scripts

```sh
npm run demo                   # start everything (options in DEMO.md)
npm run demo:check             # is everything up?
npm run demo:urls              # print the URLs again, including the Quest URL
npm run demo:reset             # clear the incident
npm run dev                    # server (live mode, address lookup) + console
npm run typecheck              # tsc across all workspaces

npm test -w agent              # agent tests
npm test -w server             # server tests
npm run smoke -w agent         # can we reach Nemotron, and does it call tools?
npm run try -w agent -- "smoke on floor 3"   # run one message through the real agent
npm run photon -w agent -- --terminal        # test the text line from this terminal

npm run generate -w data       # regenerate the building
npm run validate -w data       # sanity-check it
```

See [CLAUDE.md](CLAUDE.md) for folder ownership and team rules.
