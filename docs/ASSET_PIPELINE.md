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
Place files under `public/assets/{models,textures,audio}` and register them in
`public/assets/manifest.json` (generate with `npm run assets:manifest`). The manifest maps
logical ids to files:

```json
{ "version": 1, "assets": [
  { "id": "car.modern-supercar", "type": "model", "file": "models/supercar.glb", "bytes": 812345 },
  { "id": "texture.road.asphalt", "type": "texture", "file": "textures/asphalt.ktx2", "bytes": 262144 }
]}
```

Integration points:
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

Recommended external tools: `gltf-transform` (`gltf-transform optimize in.glb out.glb
--compress draco --texture-compress webp`), `toktx` for KTX2, `ffmpeg` for audio.
