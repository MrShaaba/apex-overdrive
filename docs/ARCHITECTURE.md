# Architecture

Apex Overdrive is a single-page application: React renders menus, HUD and overlays; a
custom engine (`src/game/core/Engine.ts`) owns the WebGL canvas, physics and audio.
The two halves communicate through an observable **GameStore** (engine → UI, ~20 Hz for
the HUD) and a typed **EventBus** (both directions, discrete events).

```
┌────────────────────────── React (src/ui) ──────────────────────────┐
│ Screens  ·  HUD  ·  Touch controls  ·  Overlays (pause/replay/photo)│
└───────────────▲──────────────────────────────┬──────────────────────┘
        useGameStore(selector)          Engine.get().method()
┌───────────────┴──────────────────────────────▼──────────────────────┐
│                          Engine (orchestrator)                       │
│  Input ─▶ AI drivers ─▶ Vehicle controllers ─▶ Rapier world (120 Hz) │
│      ▼                                                    ▼          │
│  RaceManager (checkpoints, laps, positions, elimination, pits)       │
│      ▼                                                    ▼          │
│  Weather · Sky/time · Track hazards · Particles · Camera rig         │
│      ▼                                                    ▼          │
│  Three.js scene ─▶ PostPipeline (GTAO → bloom → grade → AA → out)    │
│  AudioEngine (engine voices, SFX, ambience, adaptive music)          │
│  Replay recorder · Ghost player · Progression/achievements/save      │
└─────────────────────────────────────────────────────────────────────┘
```

## Frame loop

`Engine.loop` runs on `requestAnimationFrame`:

1. `QualityManager.update` — smoothed frame time drives dynamic resolution.
2. `InputManager.update` — keyboard/gamepad/touch/tilt → normalised `InputState`.
3. AI — each `AIDriver.update` produces a `VehicleInput` from the racing line + traffic.
4. `PhysicsWorld.update(dt, preStep)` — fixed 1/120 s steps with an accumulator (max 8
   catch-up steps). Before each step every `VehicleController.step` applies suspension,
   tyre, drive and aero forces. Contact-force events are drained after each step.
5. `RaceManager.update` — progress along the spline, checkpoint validation, lap timing,
   standings, pit service, elimination timer, finish detection.
6. Visual sync — `Vehicle.update` interpolates render transforms between physics states
   (`alpha`), spins wheels, toggles lights, emits particles and feeds audio voices.
7. Weather/sky/track hazards/props visibility, camera rig, post-processing render.
8. HUD snapshot pushed to the store every 50 ms; replay frames recorded at 20 Hz.

## Key systems

### Physics — `src/game/physics`
* `PhysicsWorld` wraps Rapier: fixed-step integration, collider metadata registry
  (surface type, vehicle id, wall flag), contact force events, static helpers.
* `VehicleController` is a raycast car (see `docs/PHYSICS.md`).
* `Surfaces` defines grip/rolling resistance/particle type per surface and blends in
  weather (wet, snow, ice) and tyre compound modifiers.

### Vehicles — `src/game/vehicles`
* `VehicleSpec` is the single data model; `applyUpgrades()` produces the tuned spec used
  by physics, `computeRatings()` produces the garage bars from the same numbers.
* `CarMeshBuilder` lofts each body shape from silhouette curves into a smooth PBR shell
  with glass, lights, wing/bumper/rim variants, liveries and runtime dent deformation.
* `Vehicle` ties controller + visual + audio voice + particle emission + drift scoring.

### Tracks — `src/game/tracks`
* `TrackCatalog` — declarative layouts (control points + features in spline space).
* `Spline` — Catmull-Rom resampled every 2 m with tangent/right/up/curvature/banking
  and a spatial hash for nearest-sample queries.
* `TrackBuilder` — road/curb/shoulder/skirt ribbons, terrain heightmap (sunk under the
  road corridor, trimesh collider), tunnels, bridges, shortcuts, pit lane, jumps, start
  gantry, grid slots, checkpoints (optional where shortcuts bypass them), sectors,
  trackside cameras, minimap data.
* `TrackProps` — chunked instanced scenery with distance culling, buildings with
  colliders near the road, crowds/grandstands (segmented along the spline), street
  lights, neon signs, water.
* `Hazards` — kinematic/dynamic moving hazards (train, crane, gate, rockfall, bales,
  avalanche, mine carts, truck, ice patches, fountains).

### AI — `src/game/ai`
* `RacingLine` smooths the centreline into an out-in-out line inside track limits and
  builds a reference speed profile (lateral-g limit, backward braking pass, forward
  acceleration pass).
* `AIDriver` — pure-pursuit steering by target curvature, capped by achievable lateral
  acceleration; speed control from the profile scaled by skill/weather/damage;
  overtaking side selection, blocking, personality-driven mistakes, catch-up scaling,
  start discipline, a recovery state machine (reverse → rejoin → respawn fallback).
* `DriverProfiles` — 24 named rivals across five competency tiers.

### Rendering — `src/game/render`
* `Sky` — three `Sky` dome, solar position from the hour, PMREM environment bakes
  (throttled), fog and light colour by weather/night.
* `Weather` — condition transitions, wetness/snow/ice accumulation, lightning.
* `PostProcessing` — GTAO, bloom, custom grade pass (speed blur, chromatic aberration,
  vignette, damage tint, rain-on-lens), SMAA/FXAA, output pass. Includes a start-up
  self-test that falls back to 8-bit render targets when a driver cannot blend into
  half-float buffers.
* `Particles` — CPU-simulated ring buffers drawn as `Points` with per-particle
  attributes; separate camera-following precipitation system.
* `CameraRig` — chase/far/hood/cockpit/cinematic/replay/photo with speed FOV, shake,
  roll, trackside cameras.
* `TextureFactory` — procedural canvas textures with quality-scaled resolution and
  an LRU release for streaming-style memory control.

### Gameplay — `src/game/gameplay`
`GameModes` (10 modes), `RaceManager`, `Progression` (credits, XP, ranks, unlocks,
sponsors), `Career` (6 chapters × 4 events, series), `Achievements`, `Challenges`
(daily/weekly from a date seed), `Leaderboards`, `DriftScoring`, `Replay`
(ring-buffer recorder + ghost player), `PhotoMode`.

### Persistence — `src/game/persistence`
`SaveManager` owns one versioned `PlayerProfile` document with migrations and debounced
writes; `StorageAdapter` abstracts the backend (`LocalStorageAdapter`, `MemoryStorageAdapter`,
`CloudStorageAdapter` scaffold).

### Network readiness — `src/game/net`
`NetworkProvider` contracts for matchmaking, invite-only rooms, ratings (Elo), friends,
voice and ghosts. `LocalNetworkProvider` implements them offline (ratings and ghosts are
real and persisted; queue/rooms/voice are simulated) so the UI and gameplay hooks are in
place for a server.

## Extension points
* New car: add a `VehicleSpec` to `VehicleCatalog` (+ optionally a `BodyShape` profile).
* New track: add a `TrackDefinition`; features are declared in spline space.
* New hazard: add a `HazardKind` case to `Hazards.ts`.
* New game mode: add a `GameModeDef`; `RaceManager` reads `scoring`, `pointToPoint`,
  `eliminationInterval`.
* Real assets: drop files in `public/assets` and register them in the manifest
  (`docs/ASSET_PIPELINE.md`).
* Online: implement `NetworkProvider` and call `setNetworkProvider()` at bootstrap;
  swap `SaveManager.setAdapter(new CloudStorageAdapter(...))` after sign-in.

## Debug hooks
In development builds the engine is exposed as `window.__apex`. Useful calls:
`__apex.setAutopilot(true)` (AI drives the player), `__apex.race.countdown = 0.3`,
`__apex.setCamera('cinematic')`, `__apex.post.enabled = false`, `__apex.fps`.
