# Firewatch

HackUTD '26 project. TypeScript monorepo using npm workspaces.

## Quick start

```sh
npm install
cp .env.example .env   # fill in keys
npm run dev            # server (ws://localhost:8080) + console (http://localhost:5173)
```

## Layout

| Folder      | What it is                                                         |
| ----------- | ------------------------------------------------------------------ |
| `shared/`   | Shared types (`types.ts`), WebSocket events (`events.ts`), `building.json` |
| `server/`   | Node WebSocket server on :8080 + `POST /ingest`; mock scripted incident |
| `agent/`    | Report handler (`handleReport(text)`), stubbed                     |
| `console/`  | React + Vite operator console                                      |
| `data/`     | `generate.ts` (writes `shared/building.json`) and `validate.ts`    |
| `headset/`  | XR headset app (not scaffolded yet, see its README)                |

Other scripts:

```sh
npm run typecheck              # tsc across all workspaces
npm run generate -w data       # regenerate shared/building.json
npm run validate -w data       # sanity-check shared/building.json
```

See `CLAUDE.md` for folder ownership and team rules.
