# Apex Overdrive — build audit and handoff

> Historical audit of the original source checkout. The product clone is now
> maintained separately; see [2.0 verification](docs/VERIFICATION.md) and
> [extension guide](docs/EXTENDING.md) for its changes and current limitations.

Audited 13 Oct 2026 against commit `5455d33` (36 commits, branch `main`, working tree
clean, no git remote). Everything below was verified by running it, not read off the
docs. Where a doc contradicts the code, the code wins and the drift is listed in
[Known bugs and gaps](#known-bugs-and-gaps).

Purpose: enough detail to clone this build and rebuild a 2.0 in one pass.

---

## 1. What it is

A browser-native 3D racing game. No backend, no downloads, no accounts. React renders
the menus and HUD; a custom engine owns the canvas, physics, audio and the race. It
ships 18 circuits and 23 cars, 10 game modes, a career, local two-player split screen,
racing-wheel support, replays, photo mode and a family-photo billboard track.

Built for the owner's son. Treat "feels like a real game" as the acceptance bar, not
"technically correct".

## 2. Stack

| Layer | Choice | Version |
|---|---|---|
| Rendering | Three.js | r170 (`^0.170.0`) |
| Physics | Rapier3D compat (WASM) | `^0.14.0` |
| UI | React + TypeScript (strict) | 19.1 / 5.8 |
| Build | Vite | 7 (`^7.0.4`) |
| Lint | ESLint + typescript-eslint | 9 / 8 |
| Asset tooling | gltf-transform CLI, meshoptimizer, basisu | 4.5 / — / 1.16 |
| Browser tests | puppeteer-core against system Chrome | 24.43 |
| Runtime verified | Node | v22.23.2 |

Requirements: Node 18+, WebGL 2 + WebAssembly. Repo on disk is 3.3 GB, of which
1.9 GB is the gitignored `assets-src/` raw downloads.

## 3. Layout

```
src/game/core/        Engine.ts (1576 LOC, orchestrator), Settings, Store, EventBus, Logger, MathUtils
src/game/physics/     PhysicsWorld (Rapier), VehicleController (920), TireModel, Surfaces
src/game/vehicles/    VehicleCatalog (815, 23 cars), VehicleSpec, CarMeshBuilder (794, procedural),
                      CarModelLoader (glTF + Draco + KTX2), Vehicle
src/game/tracks/      TrackBuilder (1194), TrackCatalog (637, 18 tracks), TrackProps (697),
                      Billboards (558), Spline, Hazards, data/*.points.json
src/game/render/      TextureFactory (591, canvas textures + image cache), CameraRig, CockpitWheel,
                      PostProcessing, Sky, Particles, Weather, QualityManager, Showcase
src/game/ai/          AIDriver (392), RacingLine, DriverProfiles
src/game/gameplay/    RaceManager (458), GameModes, Career, Progression, Challenges, Achievements,
                      DriftScoring, Replay, PhotoMode, Leaderboards
src/game/audio/       AudioEngine (458), EngineSynth, MusicSystem — fully procedural Web Audio
src/game/input/       InputManager (364), Gamepads (236) — keyboard, pads, wheels, touch, tilt
src/game/persistence/ SaveManager (308, SAVE_VERSION 3 + migrations), StorageAdapter
src/game/net/         LocalNetworkProvider + typed contracts — offline stub, no server
src/ui/screens/       MainMenu, RaceSetup, Garage, Gallery, Career, Stats, Rankings, Results,
                      Options, Multiplayer, Loading
src/ui/hud/           HUD, Minimap, Speedometer, PauseMenu, TouchControls, RaceOverlay,
                      ReplayControls, PhotoOverlay
tools/asset-pipeline/ 17 scripts — prepare-car, prepare-track, prepare-props, prepare-photos,
                      convert-hdri, build-manifest, validate, plus glTF inspection helpers
tests/                collider-audit, split-screen, wheel-calibration, billboards (516 LOC, Puppeteer)
docs/                 ARCHITECTURE, PHYSICS, PERFORMANCE, ASSET_PIPELINE, BUILD, SETUP, CONTROLS, ROADMAP
```

Total: **19,246 LOC** of TypeScript across `src/`.

## 4. Architecture

React and the engine are separate and talk two ways only:

- **GameStore** — observable, engine to UI, about 20 Hz for HUD values.
- **EventBus** — typed discrete events, both directions.

`Engine.loop` runs on `requestAnimationFrame`: input to AI drivers to vehicle
controllers to a fixed 60 Hz Rapier step, then RaceManager (checkpoints, laps,
positions, elimination, pits), then weather/sky/hazards/particles/camera, then the
Three scene through the post chain (GTAO, bloom, grade, AA), then audio and the
replay recorder.

Key structural facts a rebuild must preserve:

- **`TrackDefinition` is pure data.** Control points in metres, every feature in
  normalised spline parameter space (0..1), so a layout can be reshaped without
  breaking its tunnels, bridges, crowds or hazards. This is what makes track variants
  (such as Fam Jam) a data clone rather than a code fork.
- **Licensed circuits supply their own geometry** through an optional `model` field;
  the centreline is derived from the road mesh by `prepare-track.mjs` into
  `data/<id>.points.json`. Procedural circuits build road, terrain and props from the
  spline.
- **Everything is disposable.** `BuiltTrack.dispose()` frees geometry, materials and
  Rapier bodies; `TextureFactory.releaseUnused()` frees textures by key. Leaks here
  caused a shipped bug (see B-FIXED-2).
- **Vehicles are raycast, not rigid-body wheels** — spring/damper suspension,
  magic-formula tyres, load transfer, aero, damage.

## 5. Content

**18 circuits.** Nine procedural (island-causeway, lakeside-circuit, woodland-raceway,
metro-loop, badlands-run, alpine-ridge, shipyard-district, glacier-road,
neon-boulevard) and nine from licensed models (drift-park, spa, bugatti, hungaroring,
sepang, shanghai, marina, indianapolis, suzuka), plus `sepang-fam-jam`, a data clone of
Sepang carrying photo billboards.

**23 cars**: 9 formula, 6 GT, 5 supercar, 2 muscle, 1 vintage. All licensed glTF models;
the procedural cars were retired in `f40fbf8` but `CarMeshBuilder.ts` (794 LOC) remains
as the fallback path.

**10 game modes**: career, quick, timetrial, championship, elimination, drift, sprint,
endurance, knockout, freeroam. Each carries AI counts, lap rules, scoring type, payout
and XP multipliers.

**Assets** (`public/assets`, 338 MB models + 6.1 MB HDRI + 1.4 MB photos): 34 `.glb`
files, all verified Draco-compressed geometry with KTX2/basisu textures embedded.
137 attribution lines in `models/ATTRIBUTION.md`, all CC-BY-4.0. Transcoders are
committed at `public/libs/{basis,draco}`.

## 6. Asset pipeline

Raw downloads live in `assets-src/` (gitignored, 1.9 GB); only compressed output under
`public/assets/` is committed. `public/assets/photos/` is also gitignored — family
photos never enter git.

| Input | Command | Output |
|---|---|---|
| Sketchfab car glTF | `node tools/asset-pipeline/prepare-car.mjs <car-id>` | `models/cars/<id>.glb` |
| Sketchfab circuit | `node tools/asset-pipeline/prepare-track.mjs <id>` | `models/tracks/<id>.glb` + `data/<id>.points.json` |
| Poly Haven EXR | `node tools/asset-pipeline/convert-hdri.mjs <in.exr> <out.hdr>` | 2048×1024 RLE `.hdr` + sun longitude |
| Family photos | `npm run assets:photos` | `photos/fam-jam/*.jpg` + `manifest.json` |
| Any | `npm run assets:manifest` / `npm run assets:validate` | `manifest.json` / validation |

`prepare-car.mjs` does the heavy lifting: re-frames to metres with +Z forward and ground
at y=0, rigs tyres as `wheel_0..3` (FL, FR, RL, RR) with `wheel_N_spin` children, splits
per-axle rim and brake meshes left/right by triangle position, groups the rest under
`body` with `cockpit_hidden` and `light_brake`, then encodes KTX2 (UASTC colour 2048²,
UASTC normals 1024², ETC1S roughness/metal 1024²) and Draco-compresses geometry.

## 7. Build, test, verify — current status

All verified on 13 Oct 2026:

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | passes in 1.54 s |
| `npm test` | all four suites pass |

Bundle (gzip): rapier 761 KB, index 326 KB, three 141 KB, react 4 KB, CSS 5.8 KB.

Test suites need a dev server (`npm run dev`) and system Chrome; they drive the real
game headlessly:

- **`collider-audit.mjs`** — samples the drivable band of every circuit every 2 m along
  and across with a box 5 cm to 1.45 m above the road, failing on any non-ground
  collider. Last run: **all circuits clean**, 0 invisible colliders, 0 steps.
- **`split-screen.mjs`** — fakes two pads, runs stacked and side-by-side two-player,
  checks both viewports render, both HUDs mount, inputs route to the right car.
  Measured ~61 fps headless on software GL.
- **`wheel-calibration.mjs`** — wheel axis/pedal calibration and saved device profiles.
- **`billboards.mjs`** — placement rules, photo rotation, caption strips, collider
  safety, texture release, and a frame-rate budget. Measured: plain Sepang 261 fps,
  Fam Jam variant 245 fps uncapped, inside the 10 % budget the test enforces.

---

## Known bugs and gaps

Ordered by how much they matter to a 2.0.

### B1 — New profiles show every licensed circuit locked until a reload
**Confirmed in code.** `SaveManager.ts:116` hardcodes a new profile's `unlockedTracks`
to four procedural circuits. The catch-up loop that adds circuits at or below the
player's level (`SaveManager.ts:201`) sits only in the branch that loads an *existing*
profile, so on a brand-new profile the nine licensed circuits, which are all
`unlockLevel: 1`, stay locked until the next page load. First impression on a fresh
install is a game that looks half-empty.
**Fix:** derive `unlockedTracks` from the catalog at read time, or run the catch-up loop
on `createDefaultProfile()` as well. Do not hardcode ids.

### B2 — Yas Marina never converted
`assets-src/models/tracks/yas_marina_circuit_abu_dhabi_2021_layout` is present but no
`public/assets/models/tracks/yas.glb` exists and there is no catalog entry. Every other
downloaded circuit converted. Cause never diagnosed; run `prepare-track.mjs` against it
and read the failure.

### B3 — Walls intrude into the drivable band on six circuits
The collider audit passes (nothing invisible) but reports *visible* obstacles inside the
measured band: marina 6, indianapolis 3, suzuka 3, shanghai 2, hungaroring 2,
sepang-fam-jam 2, spa 3. Tops sit up to 1.4 m above the road at lateral offsets of 5 to
8 m. Either the licensed models' walls encroach or the `halfWidths` derived from the
road mesh are too generous at those points. A car put wide there hits a wall that looks
like scenery.

### B4 — Documentation contradicts the build
`README.md` still advertises "Nine performance cars, nine circuits" against 23 and 18.
`docs/ASSET_PIPELINE.md` opens with "Apex Overdrive ships **no binary assets**" against
338 MB of committed models. Both predate the licensed-asset work. Anyone reading the
docs to rebuild will build the wrong game.

### B5 — First load ships 2 MB of Rapier before anything moves
`rapier-DpxwuBBO.js` is 2.06 MB raw, 761 KB gzipped, loaded up front. Physics could be
deferred until a race actually starts, or moved to a Web Worker (Rapier supports it),
which also decouples simulation from rendering.

### B6 — Circuit models are large and unstreamed
spa 36 MB, hungaroring 34 MB, suzuka 28 MB, bugatti 19 MB, drift 15 MB. Each loads whole
before a race. No LOD or streaming for track geometry, unlike scenery props which chunk
and cull at 120 m. On a slow connection the loading screen is long.

### B7 — Tests are macOS-only and need a server running
Chrome is hardcoded to `/Applications/Google Chrome.app/...` (overridable by `CHROME`),
and every suite exits 2 without a dev server on `localhost:5173`. `npm test` therefore
fails on a clean checkout with no explanation beyond "no dev server". CI would need
both wired up.

### B8 — Fam Jam billboards carry no captions
By design, not a defect: captions come from file names, and all 31 photos are still
iPhone UUID exports, so `prepare-photos.mjs` correctly suppresses the caption strips.
Renaming a file to a person's name and rerunning the pipeline gives that board a
caption. Worth surfacing in the UI so it does not read as a bug.

### B9 — 19 of 24 billboard slots place on Sepang
Five slots are rejected by the placement rules (verge too uneven, or the model's own
scenery occupies the footprint). The test asserts a floor of 16, so this is accepted
rather than broken, but the lap has gaps where boards were intended.

### B10 — No online multiplayer
`src/game/net` is a complete set of typed contracts against `LocalNetworkProvider`, an
offline stub. The Multiplayer screen demonstrates matchmaking, rooms, friends, voice and
ghosts against that stub, so it looks functional and is not. Replay samples
(`[x,y,z,qx,qy,qz,qw]` at 20 Hz) are already a usable network snapshot format.

### B11 — Racing wheels have no force feedback
Browsers do not expose force feedback through the Gamepad API. Wheels steer and brake
correctly and calibrate per device id, but will not push back. Not fixable in a browser
without WebHID work; do not promise it in 2.0.

### Fixed earlier, keep fixed
- **B-FIXED-1** Garage cards clipped long names and the badge overlapped them (`4c2a616`).
- **B-FIXED-2** Invisible objects on the road: disposed tracks leaked their colliders into
  the next session (`2be45c2`). This is the bug the collider audit now guards.
- **B-FIXED-3** Cars bounced out of their grid slots before lights out (`6804dc5`).
- **B-FIXED-4** Cockpit view hid the road on some cars and the wheel sometimes vanished
  (`d153fc0`).

---

## 8. If you are rebuilding 2.0

What earned its place and should survive the rebuild:

1. **The data-driven `TrackDefinition`** with normalised feature parameters. It is why a
   track variant costs a data clone.
2. **The disposal discipline** — every track object tracked, textures keyed and released.
   The one time it slipped it produced B-FIXED-2.
3. **The asset pipeline.** `prepare-car.mjs` encodes hard-won conventions about rigging
   wheels and splitting rim meshes from single-mesh Sketchfab models. Rewriting it from
   scratch will cost days.
4. **The browser test suite.** It catches the class of bug that is invisible in code
   review: colliders on the racing line, split-screen routing, frame-rate regressions.
5. **Procedural audio and `TextureFactory`.** Zero asset weight, quality-scaled.

What to reconsider:

1. **Load strategy** (B5, B6) — defer physics, stream circuits, show something playable
   sooner.
2. **Unlock state derived, never stored** (B1) — storing a list of ids guarantees drift
   whenever content is added.
3. **Online for real, or cut the screen** (B10) — a mock multiplayer hub is worse than
   none.
4. **Keep the docs generated or checked** (B4) — car and circuit counts should come from
   the catalogs, not prose.

## 9. Conventions

- Commit subjects are sentence case describing the outcome, not the change
  ("Grid settle: cars drop onto their slots, settle, then hold until lights out").
- No git remote. Nothing here has ever been pushed. Family photos and raw assets are
  gitignored and must stay that way.
- Shell is zsh: never put `#` comments inside command blocks meant for pasting.
- `assets-src/` is the raw-download tree; `public/assets/` is the committed compressed
  output. Never commit the former.
