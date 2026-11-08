# Handoff for Gemini: open-source assets and UI kits for the FireSight VR command room

> **How to use this file:** paste the whole file into Gemini. Gemini has no access to the
> repository, so everything it needs is in this file. Gemini does research only and writes
> no code into the repo. Bring its answer back to Claude to import the picks you choose.

---

## 1. Your task (Gemini)

Find **free, open-source, directly importable** assets and UI resources that will make our VR
fire-command room look and feel better **without building everything from scratch**.
Prefer resources we can drop into the project as files or `npm install`, not ones that need
to be modelled, retextured or rewritten.

Give **2–4 options per category** in section 5, ranked best first. Use the output format in
section 6 so the owner can choose quickly.

## 2. What the project is

FireSight is a hackathon project (HackUTD 2026). A 911/fire dispatcher wears a **Meta Quest 2**
headset and sits in a virtual **command room**:

- A **hexagonal room** with a **continuous desk wrapping around the front half** of the room.
- **Left desk section:** a live 3D model of a 12-floor office building (108 rooms). It is a
  **holographic-table style model** that the user can pick up, rotate and zoom with their hands.
  Rooms tint orange/red/grey live as fire and smoke spread.
- **Centre:** a "Voice & comms" panel listing caller reports (blue) and firefighter updates (amber).
- **Right:** a "Resources & people" panel: dispatched / en route / on scene counts, people at
  risk, the AI recommendation, plus **Accept recommendation** and **Dispatch crew** buttons.
- A setup panel with **Enter VR**, **Center room here** and **Bring building closer**.

The building geometry is generated in code from live data and must **stay procedural**. Do not
suggest replacing the building with a fixed model. Decorative pieces around it are fine
(base/plinth, hologram table, glow ring, scale figures).

## 3. Technical stack and import constraints (must respect)

| Item | Detail |
|---|---|
| Engine | **IWSDK** (Meta Immersive Web SDK) `@iwsdk/core 1.1.0-rc.2`, built on **three.js r185** (`super-three`) |
| Runtime | Quest 2 **browser** (WebXR, standalone mobile GPU, no PC tethering), served by Vite |
| 3D models | Imported as **glTF / GLB** only (`AssetType.GLTF`). Files go in `headset/public/` and are registered in a manifest. FBX/OBJ/Blend are OK only if trivially convertible to GLB (say so). |
| Textures / environment | `AssetType.Texture` (PNG/JPG/KTX2) and `AssetType.HDRTexture` (HDR environment maps). |
| UI | **pmndrs/uikit** (`@pmndrs/uikit`, `@pmndrs/uikit-horizon` kit, `@pmndrs/uikit-lucide` icons) authored as `.uikitml` markup (HTML/CSS-like, flexbox, panels, buttons). |
| Fonts | uikit renders text with **MSDF bitmap fonts**. The current font has **ASCII glyphs only**, so dashes and quotes showed up as boxes. A wider-coverage MSDF font (or a recipe to generate one) is useful. |
| Audio | MP3/OGG in `public/audio/` (one chime exists already). |

**Performance budget (Quest 2):** stay roughly under **100k triangles total** for decorative
props, **≤ 2 MB per GLB**, textures **≤ 1024px** (2048px only for one hero item), few
materials, no real-time shadows required. Flag anything that needs Draco/Meshopt/KTX2
compression, or anything heavy enough that it would need decimating.

**Licence:** prefer **CC0 / public domain / MIT**. CC-BY is acceptable if you state the
exact attribution required. **Exclude** NC (non-commercial), ND (no-derivatives), "editorial
only", or unclear licences. Do not suggest anything that needs a paid account or a sign-in wall to download.

## 4. Chosen visual style: "Studio C" (match this)

Calm architectural model studio, not sci-fi neon. Warm, soft, daylight-like.

| Element | Colour |
|---|---|
| Desk: pale oak | `#c9b18b` |
| Walls: warm off-white plaster | `#e8e3d9` |
| Floor: warm grey | `#929087` |
| Cabinets | `#d5d0c5` |
| Accents / trim: graphite | `#474b4a` |
| Ceiling light panels: warm white | `#fff6e6` |
| Building model | ivory/white cutaway with orange/red hazard tints |
| Panels | dark charcoal cards, white text, blue = callers, amber = firefighters, red = danger |

## 5. Categories to research

1. **Room environment / lighting.** Soft interior **HDRI** environment maps (studio, office,
   daylight interior) for reflections and ambient light. Also a cheap baked-lighting approach.
2. **PBR surface textures.** Oak wood, plaster, concrete/terrazzo floor, acoustic panels, brushed
   metal. Must tile and be available at ≤ 1K.
3. **Desk and room props (GLB).** Office chair, desk lamp, monitors/keyboards, radio/handset,
   wall clock, filing cabinets, plants, wall-mounted screens, whiteboard. Low-poly but realistic
   enough to fit Studio C.
4. **Fire/emergency props (GLB).** Fire extinguisher, fire alarm pull station, exit sign,
   firefighter helmet, radio, hose reel, floor-plan frame. Small decorative accents.
5. **Hologram / map-table pieces.** A base or turntable for the building model, a glowing ring,
   a scale-figure set (tiny people), a compass rose or north arrow.
6. **VR UI kits and components.** Ready-made uikit/uikitml components (cards, badges, toggles,
   progress bars, tabs, list rows, toasts). Also other **WebXR UI libraries compatible with
   three.js** that could replace or extend panels (e.g. pmndrs uikit kits, three-mesh-ui).
   State whether each one is compatible with `@pmndrs/uikit` 1.x.
7. **Icons.** Fire/emergency/status icon sets (flame, smoke, stairs, person, truck, alert) as
   SVG. Note anything already covered by **Lucide**, which we have installed.
8. **Fonts.** Open-licence fonts with **ready-made MSDF atlases** (or the tool to generate one)
   covering at least Latin-1, dashes, quotes and arrows. Must read well at VR distances.
9. **Effects (optional).** Lightweight smoke/fire particle or shader examples for three.js that
   could run on Quest 2 above burning rooms in the model.
10. **Sound (optional).** CC0 UI clicks, radio squelch, alert tones, and a quiet room-tone ambience.

Good starting points (verify each licence yourself): Poly Haven, ambientCG, Kenney, Quaternius,
Poly Pizza, Sketchfab (filter: downloadable + CC0/CC-BY), the Khronos glTF sample models, pmndrs
GitHub org, Meta IWSDK examples, Freesound (CC0 filter), msdf-bmfont / msdf-atlas-gen.

## 6. Output format (required)

For each category, return a table:

| Rank | Name | Direct URL | Licence (+ attribution text if CC-BY) | Format & size | Triangles / texture res | Fits Studio C? | Why / where it goes in the room |
|---|---|---|---|---|---|---|---|

Then finish with:

1. **Top 10 picks overall.** The quickest, highest-impact items to import first, in order.
2. **Risks.** Anything too heavy for Quest 2, with licence caveats, or that needs conversion.
3. **Attribution block.** Ready-to-paste credits for any CC-BY items.

Rules: only list resources you have actually confirmed exist at the URL. Mark anything you
could not verify as **UNVERIFIED**. Do not invent triangle counts or file sizes; write
"unknown" instead.

---

## 7. Notes for whoever imports the picks (Claude / developer)

- Put GLB files in `headset/public/models/`, register them in `headset/src/assets.ts` with
  `AssetType.GLTF` and a URL built from `import.meta.env.BASE_URL`, and place them in
  `headset/public/scenes/main.iwsdk.scene.json`.
- Room and desk geometry: `headset/src/scene-assets/command-room.scene-asset.ts`.
  Materials: `headset/src/scene-assets/studio-materials.ts` (swap the procedural textures for
  real PBR maps here). Panels: `headset/public/ui/*.uikitml`.
- Keep the building procedural (`incident-building.scene-asset.ts`). Add decoration around it only.
- Re-check the Quest 2 frame rate after each batch of imports.
- Add a `headset/public/CREDITS.md` for any CC-BY assets.
