# Asset pipeline

Apex Overdrive ships **no binary assets**: cars are lofted procedurally, textures are
painted on canvases, audio is synthesised. This keeps the game fully self-contained and
instant to load. The pipeline below is for teams that want to layer real assets on top.

## Procedural generation (default)
| Asset | Generator |
|---|---|
| Car bodies, rims, wings, lights | `vehicles/CarMeshBuilder.ts` (silhouette lofts + detail meshes, 2 LODs) |
| Liveries, plates, road/ground/facade textures, sprites, crowd, neon signs | `render/TextureFactory.ts` |
| Tracks, terrain, props, water | `tracks/TrackBuilder.ts`, `tracks/TrackProps.ts` |
| Engine/turbo/skid/impact/ambience/music | `audio/*` |

Quality-scaled: textures are created at `textureScale × base` resolution and cached by key;
`releaseUnused()` frees them between sessions.

## Overriding with external assets
Raw downloads (Sketchfab glTF folders, Poly Haven EXRs) live in `assets-src/` at the repo
root, which is **gitignored** — only compressed output under `public/assets/` is committed.
Place converted files under `public/assets/{models,textures,audio,hdri}` and register them in
`public/assets/manifest.json` (generate with `npm run assets:manifest`). The manifest maps
logical ids to files:

```json
{ "version": 1, "assets": [
  { "id": "car.modern-supercar", "type": "model", "file": "models/supercar.glb", "bytes": 812345 },
  { "id": "texture.road.asphalt", "type": "texture", "file": "textures/asphalt.ktx2", "bytes": 262144 }
]}
```

Integration points:
* **Sky panorama** — `node tools/asset-pipeline/convert-hdri.mjs assets-src/hdri/x_4k.exr public/assets/hdri/x_2k.hdr`
  decodes the EXR with three's `EXRLoader`, box-filters it to 2048×1024 and writes an RLE
  `.hdr`. It prints the sun longitude; `Engine.ts` (`SKY_HDRI`) passes that to
  `SkySystem.loadHdri()`, which PMREM-filters the panorama once, rotates it every frame so
  its sun matches the procedural sun, and dims it at night. Missing file → procedural bake.
* **Models** — `node tools/asset-pipeline/prepare-car.mjs <car-id>` (configs at the top of the
  script) turns a raw Sketchfab glTF into `public/assets/models/cars/<id>.glb`: it re-frames the
  model (metres, +Z forward, ground at y = 0, x/z = 0 at the wheelbase midpoint), rigs the tyres
  as `wheel_0..3` (FL, FR, RL, RR) with `wheel_N_spin` children, splits per-axle rim/brake meshes
  into left/right halves by triangle position, groups the rest under `body` with
  `cockpit_hidden` (the model's own steering wheel) and `light_brake` (emissive lamps), joins
  primitives per material, drops `KHR_materials_transmission`, encodes textures to KTX2 with the
  `basisu` CLI (UASTC colour 2048², UASTC normals 1024², ETC1S roughness/metal 1024², mipmapped)
  and Draco-compresses the geometry. It prints wheelbase/track/radius for the catalog entry.
  Models whose wheels are baked into the body (the SF-23) use `wheelDetect: 'contact'`: the
  four wheels are located from the ground-contact patches (axle from the tyre top, width from
  the tread-edge rings) and carved out of the body by a per-wheel cylinder test; `decimate`
  runs meshoptimizer's simplifier afterwards (713k → 285k triangles for the SF-23).
* **Road cars** — the same `prepare-car.mjs` with `wheelDetect: 'contact'`: each corner's contact patch
  (the lowest 3 cm of its quadrant) gives the wheel centre and tread width, the densest full ring
  centred on the axle gives the radius (or `wheelRadius: [front, rear]` pins the real value when a
  low-poly tread loses to a high-poly rim), and a two-wheeler whose left/right "corners" land on
  the same centred wheel keeps one rigged wheel per axle with an empty twin; `CarModelLoader`
  keeps the model's lateral wheel offset so the single wheel renders on the centreline while the
  physics still runs four contact patches.
* **Circuits** — `node tools/asset-pipeline/prepare-track.mjs <track-id>` turns a raw circuit model into
  `public/assets/models/tracks/<id>.glb` with one node per class — `road`, `kerb`, `pit`,
  `runoff`, `gravel`, `terrain`, `wall`, `overlay`, `prop` (each also as `<class>_noshadow`) —
  and derives the lap centreline from the lap surface: the core road (+ kerbs) is rasterised at
  1–2 m (`res` overrides; `coreRadius` admits general asphalt near the core rules when the track
  shares its material with paddocks and car parks), the non-road cells reachable from the raster
  border are the outside, the largest enclosed region is the infield (smaller pockets join
  whichever side their neighbours are nearer to), and the road cells equidistant from both form
  the lap band — paddocks, pit lanes and access roads never separate infield from outside, so
  they drop out without any cycle search. The band is thinned and its few junctions resolved by
  the largest-area cycle. The loop is oriented to the circuit's real
  direction, started at the model's start marker (`startMarker`, e.g. the start lights) and the
  pit zone is the stretch beside the pit asphalt nearest the start (Spa also carries its old
  Eau Rouge pits). Control points and the pit feature go to `src/game/tracks/data/<id>.points.json`
  and a `TrackDefinition` with `model` uses them; `TrackBuilder` gives road/kerb/pit/runoff/
  gravel/terrain ground colliders with matching surfaces, walls trimesh wall colliders, overlays
  a polygon offset and no collider, props scenery only, and adds a wide grass apron under the
  map; it keeps the spline, grid, checkpoints, pit-lane logic, DRS zones and minimap and skips
  its procedural surfaces, terrain, barriers, props and gantry. Rules can carry `lap: 'near'`
  (general asphalt: drives like road and widens the line, but never traces it) and the traced
  skeleton is re-centred across the full road width, stopping at wall cells, with the shift
  median-filtered so junctions and jagged raster edges do not put wobbles in the line — a metre
  of wobble reads as a corner to the AI's speed profile. The JSON also carries `halfWidths`
  (usable half-width per control point) which `RacingLine` uses as its per-index lateral limit.
  Heavy classes are decimated per primitive (the document-wide `simplify()` would eat the road)
  and positions are Draco-quantised at 20 bits (14 bits is a 13 cm grid over a 2 km circuit:
  a bumpy road and mismatched stacked surfaces). Circuit models have seams, drain strips and
  missing slivers in their road surface, so `TrackBuilder` builds an invisible safety net
  3 cm under the asphalt as the physics sees it (rays per spline sample, columns off the
  asphalt capped at their own surface) — a wheel over a gap drops centimetres, not to the
  apron. `--points-only` regenerates the centreline without rebuilding the .glb.
  `dump-gltf.mjs <scene.gltf>` prints a model's node/material/bounds table, `matinfo.mjs`
  lists materials with their base-colour texture, triangle count and extent, `texsheet.mjs`
  renders a contact sheet of those textures (the only way to read ripped exports whose
  material names are `11001Mtl_76`), and `map-track.mjs <scene.gltf> <out.png> --points <json>
  label=regex…` draws material groups with the centreline and its direction (`--crop`,
  `--points-scale`). `flatmats.mjs <scene.gltf>` is the ground census: per material the flat
  (horizontal) area, height and extent — a big flat area that no rule catches lands in `prop`
  and has no ground collider, so a car running onto it drops to the apron (Sepang's painted
  run-off and ground-painted sponsor logos). `boxmats.mjs <scene.gltf> x0,z0,x1,z1…` lists the
  materials inside a footprint, `near-materials.mjs` those around a point. Rules can also
  give `cls: 'drop'` to invisible helper meshes (Sepang ships a circuit-wide alpha-0 sheet).
  Re-centring walks reach 14 m each way (a hairpin with run-off asphalt outside it is
  20 m wide) and stop at kerbs, walls, verges or gravel laid over the asphalt polygon, and
  asphalt that steps down 8 cm within half a metre (a lower run-off sheet); of two roads
  running side by side between the same skeleton junctions (apron, pit lane, service road)
  only the wider survives. Figure-eight circuits (Suzuka) get `crossings: [[x, z]]` — the overpass reads as one
  4-way skeleton junction that no simple cycle can pass twice, so the tracer pairs each arm
  with the arm opposite it and splits the junction into two straight-through passes, then
  ranks cycles by length (the lobes wind in opposite directions and cancel in the area sum).
  Ripped exports put the pit lane under a material of its own (Sepang: concrete slabs +
  blue pit-box floors) and a look-alike service strip elsewhere — check the pit zone the
  tracer prints against the start straight before trusting it.
* **Scenery library** — `node tools/asset-pipeline/prepare-props.mjs city` groups a scene's objects by
  footprint overlap into props, drops ground sheets, classifies them by size (building, shop,
  railing, bollard, post, billboard), centres each on its footprint with its base at y = 0 and
  writes `public/assets/models/props/city.glb` with one `<kind>_<n>` node per prop (footprint
  in the node extras). `TrackProps.buildProps()` takes the loaded library: on city circuits the
  generated box buildings are replaced by scaled library buildings (same placement and colliders),
  and every procedural circuit gets shops beside the road, railings along the start straight and
  bollards on the outside of corners. Trees, rocks and theme props stay procedural.
* **Cockpit props** — a config with `kind: 'prop'` (the McLaren steering wheel) skips the wheel
  rig: the model is scaled, its `pivot` moved to the origin and everything joined under a `prop`
  node. `render/CockpitWheel.ts` clones it into the spinner when Engine has preloaded it and
  keeps the procedural rim as the fallback.
  A catalog car opts in with `model: CarModelRef` (`VehicleSpec.ts`): `vehicles/CarModelLoader.ts`
  preloads the file with `GLTFLoader` + `DRACOLoader` + `KTX2Loader` (decoders under
  `public/libs/`) and `buildCarVisual()` clones it into a `CarVisual`; a missing file means the
  procedural car. AI fields never draw licensed models.
* **Textures** — `TextureFactory.get(key, painter)` can be pre-seeded: load the texture and
  insert it in the cache under the same key the generator would use (e.g. `road:#2e2f33`).
* **Audio** — `AudioEngine` accepts decoded `AudioBuffer`s for one-shots; replace
  `playImpact`/`playGearShift` bodies with buffer playback.

## Budgets (enforced by `npm run assets:validate`)
| Type | Max per file | Notes |
|---|---|---|
| model (`.glb`) | 20 MB | Draco geometry + KTX2 textures (see prepare-car.mjs); licensed cars run 100–330k tris |
| texture (`.ktx2`, `.webp`, `.jpg`, `.png`) | 1 MB | ≤ 2048², prefer KTX2/Basis |
| audio (`.ogg`, `.mp3`, `.webm`) | 500 kB | 44.1 kHz mono for positional sounds |
| hdri (`.hdr`) | 8 MB | 2048×1024 RGBE, RLE (≈6 MB) |

Recommended external tools: `gltf-transform` (`gltf-transform optimize in.glb out.glb
--compress draco --texture-compress webp`), `toktx` for KTX2, `ffmpeg` for audio.
