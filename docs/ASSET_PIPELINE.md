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
* **Models** — load with `GLTFLoader` (+ `DRACOLoader`/`KTX2Loader` from three's examples)
  and return a `CarVisual`-compatible object from a loader that mirrors `buildCarVisual()`.
  Keep the wheel hubs as separate nodes named `wheel_0..3` and the body as `body`.
* **Textures** — `TextureFactory.get(key, painter)` can be pre-seeded: load the texture and
  insert it in the cache under the same key the generator would use (e.g. `road:#2e2f33`).
* **Audio** — `AudioEngine` accepts decoded `AudioBuffer`s for one-shots; replace
  `playImpact`/`playGearShift` bodies with buffer playback.

## Budgets (enforced by `npm run assets:validate`)
| Type | Max per file | Notes |
|---|---|---|
| model (`.glb`) | 2 MB | Draco/meshopt-compressed, ≤ 40k tris per car |
| texture (`.ktx2`, `.webp`, `.jpg`, `.png`) | 1 MB | ≤ 2048², prefer KTX2/Basis |
| audio (`.ogg`, `.mp3`, `.webm`) | 500 kB | 44.1 kHz mono for positional sounds |
| hdri (`.hdr`) | 8 MB | 2048×1024 RGBE, RLE (≈6 MB) |

Recommended external tools: `gltf-transform` (`gltf-transform optimize in.glb out.glb
--compress draco --texture-compress webp`), `toktx` for KTX2, `ffmpeg` for audio.
