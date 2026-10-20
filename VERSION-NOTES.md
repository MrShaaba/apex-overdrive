# Version notes — Apex Overdrive (f1-sim-v2)

Snapshot of the browser racing game (Three.js + React + Vite + Rapier) for comparison on
another machine. App version `2.0.0` (package.json).

## Branches

| Branch | What it is |
|---|---|
| `main` | The original version (36 commits, 2026-08-30 → 2026-09-12). Same history as the older local copy `Dev/apex`. |
| `product/overdrive-2` | `main` plus one commit (2026-10-13): stable driving, family-photo billboards (Sepang - Fam Jam), and configurable two-player wheel racing. Also carries these notes. |

## How to run

Requirements: Node 22.12+ and a browser with WebGL 2 + WebAssembly (Chrome, Edge, Firefox, Safari 16+).

```sh
npm ci
npm run build
npm start        # opens the production build at http://127.0.0.1:4173
```

For development, use `npm run dev`. For the full gate (types, lint, build, browser regressions and a production smoke test), use `npm run check`. On macOS you can also double-click `Start Apex.command`.

Family photos are **not** in the repo. Without them, the Sepang - Fam Jam billboards are blank. To fill them, put photos in `assets-src/photos/fam-jam/` and run `npm run assets:photos`. See docs/ASSET_PIPELINE.md.

## Tracks and what makes them realistic

There are 19 selectable layouts: procedural circuits plus model-based real circuits.

Model-based circuits: Spa-Francorchamps (2022), Hungaroring (2020), Suzuka (2001), Shanghai (2018), Sepang (2025), Marina Bay, Indianapolis, Bugatti (Le Mans, 2017) and a drift track. Sepang - Fam Jam is a variant of Sepang with 24 photo billboards.

- **Layout source.** Each real circuit is a Sketchfab model of the actual layout (see the license table). The geometry is used as-is and is not hand-drawn.
- **Racing line and centreline.** `tools/asset-pipeline/prepare-track.mjs` rasterises the road surface at 1–2 m. It then derives the lap centreline as the band equidistant from the infield and the outside, so paddocks and pit lanes drop out. It orients the lap to the circuit's real direction and starts it at the model's start lights. It also records the usable half-width at each control point, which the AI racing-line optimiser uses as its lateral limit.
- **Elevation.** Elevation comes from the circuit model itself, so real elevation changes are kept (Sepang has 22 m over a lap; Spa is far hillier). Positions are Draco-quantised at 20 bits, because 14 bits gives a 13 cm grid that makes the road bumpy. An invisible safety net 5 mm above the asphalt covers seams and gaps in the source road meshes.
- **Surfaces.** The model is split into road, kerb, pit, run-off, gravel, terrain, wall and prop classes. Each class gets its own collider and surface type, so grip, rumble and gravel slow-down differ by surface.
- **Textures and lighting.** Model textures are re-encoded to KTX2 (UASTC colour/normals, ETC1S roughness/metal). Lighting is a real HDRI sky (Poly Haven "Nqweba Dawn"), PMREM-filtered and rotated with time of day. Post-processing adds GTAO, bloom and SMAA/FXAA. Procedural circuits use generated textures (`render/TextureFactory.ts`) and the city scenery library.
- **Car models.** 23 licensed cars: F1 (W11, W13, W14, MCL35M, SF23, MP4/5, Lotus 72D, Jaguar Formula E) plus GT, DTM and road cars. They are Draco- and KTX2-compressed and rigged with measured wheelbase, track and wheel radius. A licensed McLaren steering-wheel model is used in the cockpit.
- **Physics.** A Rapier rigid-body chassis with four raycast wheels at a fixed 120 Hz. It models spring/damper suspension with separate bump and rebound, magic-formula tyres, load transfer, aero downforce and drag, speed-limited steering lock, and torque curves for ICE, EV and hybrid. It also covers turbo and supercharger, ERS boost, damage, and surface- and weather-dependent grip. Details are in docs/PHYSICS.md. `product/overdrive-2` adds stability fixes and calibrated direct wheel input (Logitech G29/G920/G923 class) for two players.

## Main dependencies (installed versions)

| Package | Version | Role |
|---|---|---|
| three | 0.170.0 | Rendering |
| @dimforge/rapier3d-compat | 0.14.0 | Physics (WASM) |
| react / react-dom | 19.2.0 | Menus and HUD |
| vite | 7.3.7 | Dev server and bundler |
| typescript | 5.8.3 | Type checking |
| @vitejs/plugin-react-swc | 3.11.0 | React transform |
| @gltf-transform/cli | 4.5.1 | Asset pipeline (dev) |
| basisu | 1.16.3 | KTX2 texture encoding (dev) |
| puppeteer-core | 24.43.1 | Browser regression tests (dev) |
| eslint | 9.39.1 | Lint (dev) |

`public/libs/` vendors the Draco and Basis decoders from the Three.js examples (Apache-2.0).

## Large assets (over 5 MB)

All are committed under `public/assets/` and are well under GitHub's 100 MB per-file limit.

| File | Size | Source |
|---|---|---|
| models/tracks/spa.glb | 36.1 MB | Circuit de Spa-Francorchamps 2022 layout |
| models/tracks/hungaroring.glb | 34.1 MB | Hungaroring 2020 layout |
| models/tracks/suzuka.glb | 27.5 MB | Suzuka Circuit 2001 layout |
| models/tracks/bugatti.glb | 19.3 MB | Bugatti Circuit 2017 layout |
| models/cars/mp45.glb | 17.9 MB | McLaren MP4/5 Formula 1 |
| models/cars/charger.glb | 16.8 MB | Dodge Charger Fast & Furious 8 |
| models/tracks/drift.glb | 15.0 MB | Drift Race Track Free |
| models/cars/enforcer.glb | 14.7 MB | The Terminus Enforcer |
| models/cars/w201.glb | 13.9 MB | 1982 Mercedes W201 |
| models/tracks/shanghai.glb | 11.6 MB | Shanghai International Circuit 2018 layout |
| models/tracks/indianapolis.glb | 11.3 MB | Indianapolis Motor Speedway |
| models/cars/sf23.glb | 9.9 MB | Scuderia Ferrari F1 SF23 2023 |
| models/tracks/marina.glb | 9.5 MB | Marina Bay Street Circuit |
| models/cars/w13.glb | 8.9 MB | F1 Mercedes W13 Concept |
| models/cars/w11.glb | 8.5 MB | Mercedec F1 2020 |
| models/cars/ccoupedtm.glb | 8.5 MB | 2018 Mercedes C-Coupé DTM |
| models/cars/revuelto.glb | 8.4 MB | Lamborghini Revuelto |
| models/tracks/sepang.glb | 8.0 MB | Sepang International Circuit 2025 layout |
| models/cars/w14.glb | 7.4 MB | Mercedes-AMG W14 Formula One 2023 |
| models/props/city.glb | 7.3 MB | street city (7) for games FREE |
| hdri/nqweba_dawn_2k.hdr | 6.1 MB | Poly Haven "Nqweba Dawn" (4k EXR converted to 2k HDR) |
| models/cars/clkdtm.glb | 6.0 MB | 2002 Mercedes CLK DTM D2 |
| models/cars/gtrfina.glb | 5.8 MB | 1995 McLaren F1 GTR Fina |
| models/cars/mcl35m.glb | 5.6 MB | F1 2021 McLaren MCL35M |

All `.glb` files are compressed conversions of Sketchfab downloads. The raw downloads are in the gitignored `assets-src/` folder.

## Downloaded assets and licenses

Full credits are in `public/assets/models/ATTRIBUTION.md`. Keep those notices wherever the project is shared. Audio, most textures, liveries, crowd and signage are procedural (generated in code) and are not downloads.

| License | Assets | Can it be published? |
|---|---|---|
| **CC-BY-4.0** | All 9 circuits except drift; W11, W13, W14 (free), MCL35M, SF23, MP4/5, Lotus 72D, Jaguar I-Type 4, W201, McLaren F1 GTR (Fina, Gulf, Longtail), CLK DTM, C-Coupé DTM, SLS safety car, AMG One, Terminus Enforcer; McLaren steering wheel | Yes, with attribution |
| **CC0** (Poly Haven) | `hdri/nqweba_dawn_2k.hdr` | Yes, no conditions. Not yet listed in ATTRIBUTION.md. |
| **CC-BY-NC-4.0** | Countach LPI 800-4, Revuelto, Huracán EAGLE, Dodge Challenger truck | **Non-commercial only.** Not allowed in paid or commercial work. |
| **CC-BY-NC-SA-4.0** | Mercedes-AMG W14 2023 (`w14.glb`), Dodge Charger F&F8 | **Non-commercial only**, and derivatives must use the same license. |
| **CC-BY-ND-4.0** | Drift Race Track Free (`drift.glb`) | **No derivatives.** The track was split, decimated and re-encoded, which is likely a derivative, so it should not be shared in this modified form. |
| **Sketchfab Standard** | `props/city.glb` (street city (7) by dasy444) | Use in a product is allowed, but **redistributing the model file itself is not**. A public repo exposes the extractable file. Not yet listed in ATTRIBUTION.md. |

Before anything goes public or into paid work, remove or replace the NC, NC-SA, ND and Sketchfab Standard assets above. Also note that real car, team and circuit names (Mercedes, Ferrari, McLaren, Lamborghini, Formula 1 and so on) are trademarks. The model licenses cover the meshes, not the brands.

## Kept out of the repo

`node_modules/`, `dist/`, `dist-ssr/`, `build/`, `.env*` (except `.env.example`), `*.local`, `assets-src/` (raw downloads and source photos), `public/assets/photos/` (processed family photos and manifests), `tests/shots/` and logs.
