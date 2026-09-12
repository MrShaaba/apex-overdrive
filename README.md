# Apex Overdrive

A premium, browser-native 3D racing game. Nine performance cars, nine circuits with shortcuts, tunnels, bridges and live hazards, a 13-car AI field with personalities, dynamic weather and time of day, a full career, garage customization, replays, photo mode and leaderboards — all running in one modern web stack with **no downloads and no backend**.

| | |
|---|---|
| Rendering | [Three.js](https://threejs.org) r170 — PBR materials, PMREM environment lighting, cascaded-style shadow focus, GTAO ambient occlusion, bloom, speed blur, SMAA/FXAA |
| Physics | [Rapier](https://rapier.rs) (WASM) rigid bodies + a custom raycast vehicle model (spring/damper suspension, magic-formula tyres, load transfer, aero, damage) |
| UI | React 19 + TypeScript, CSS animations, responsive down to phones, touch/tilt controls, gamepad |
| Audio | 100% procedural Web Audio: layered engine synthesis, turbo, skids, impacts, ambience, adaptive music, 3D positioning |
| Persistence | Versioned save profile in `localStorage` behind a `StorageAdapter` (cloud adapter scaffolded) |
| Tooling | Vite 7, ESLint, TypeScript strict mode |

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Requirements: Node 18+, a browser with WebGL 2 + WebAssembly (Chrome, Edge, Firefox, Safari 16+). See [docs/SETUP.md](docs/SETUP.md) for details and troubleshooting.

## Controls

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Steer | A / D or ← / → | Left stick | ◀ ▶ buttons or tilt |
| Throttle / Brake | W / S or ↑ / ↓ | RT / LT | GAS / BRAKE |
| Handbrake | Space | B | E-BRK |
| Nitrous | Shift | Stick up / L3 | NOS |
| Gears (manual) | Q / E | LB / RB | — |
| Camera | C | Y | CAM |
| Look back | B | Stick down | — |
| Reset car | R | Select | RESET |
| Photo mode | F | — | — |
| Replay (after finish) | V | — | — |
| Hide HUD | N | — | — |
| Pause | Esc / P | Start | ❚❚ |

Racing wheels (Logitech G29 / G920 / G923 and similar) and several controllers are supported: calibrate and assign them to players in Options → Controls. Local two-player split screen (top/bottom or side by side) is in Race Setup → Players. **Sepang - Fam Jam** puts your own photos on trackside billboards: drop them in `~/Downloads/fam-jam` and run `npm run assets:photos` (see docs/ASSET_PIPELINE.md); without photos the boards are blank. Full list in [docs/CONTROLS.md](docs/CONTROLS.md).

## Project layout

```
src/
  main.tsx, App.tsx          React shell, screen routing
  index.css                  design tokens + all UI styles
  game/
    core/       Engine (loop/orchestration), EventBus, Settings/quality, Store, Logger, math
    physics/    PhysicsWorld (Rapier), VehicleController (raycast car), TireModel, Surfaces
    vehicles/   VehicleSpec (data model, upgrades, customization), VehicleCatalog (9 cars),
                CarMeshBuilder (procedural car bodies), Vehicle (entity)
    tracks/     TrackCatalog (9 circuits), Spline, TrackBuilder, TrackProps, Hazards
    ai/         DriverProfiles (24 rivals, tiers), RacingLine (optimiser + speed profile), AIDriver
    render/     Sky/time-of-day, Weather, PostProcessing, CameraRig, Particles, TextureFactory,
                QualityManager (dynamic resolution), Showcase (menu studio)
    audio/      AudioEngine (mixer, 3D voices, SFX, ambience), EngineSynth, MusicSystem
    gameplay/   GameModes, RaceManager, Progression, Career, Achievements, Challenges,
                Leaderboards, DriftScoring, Replay/ghosts, PhotoMode
    input/      InputManager (keyboard, gamepad, touch, tilt)
    persistence/ StorageAdapter (local / memory / cloud scaffold), SaveManager (migrations)
    net/        NetworkProvider contracts + offline implementation (matchmaking, rooms,
                ratings, friends, voice, ghosts)
    state/      GameStore (UI-facing observable state)
  ui/
    screens/    Menu, Career, Garage, RaceSetup, Rankings, Gallery, Options, Stats, Results, Online
    hud/        HUD, Speedometer, Minimap, TouchControls, PauseMenu, ReplayControls, PhotoOverlay
    components/ Button, Controls, Screen, Toasts
docs/           architecture, setup, build, physics, performance, asset pipeline, roadmap
tools/asset-pipeline/  manifest + validation scripts for optional external assets
public/assets/  optional asset overrides (the game generates everything procedurally by default)
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — systems, data flow, frame loop, extension points
- [Physics & handling model](docs/PHYSICS.md) — tyre/suspension/aero math and tuning knobs
- [Setup](docs/SETUP.md) — local development, browser requirements, debugging hooks
- [Build & deploy](docs/BUILD.md) — production build, hosting, chunking
- [Performance](docs/PERFORMANCE.md) — quality tiers, budgets, profiling notes, mobile
- [Asset pipeline](docs/ASSET_PIPELINE.md) — procedural assets, overriding with real assets
- [Controls](docs/CONTROLS.md)
- [Roadmap](docs/ROADMAP.md) — future additions incl. multiplayer

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Vite dev server with HMR (`--host` exposes it on the LAN for phone testing) |
| `npm run build` | Type-check + production bundle into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | `tsc -b` only |
| `npm run lint` | ESLint |
| `npm run assets:manifest` | Regenerate `public/assets/manifest.json` from files on disk |
| `npm run assets:validate` | Validate asset sizes / formats against the budget |

## License

Source code © 2026 Apex Overdrive contributors. All in-game brands, drivers and circuits are fictional.
