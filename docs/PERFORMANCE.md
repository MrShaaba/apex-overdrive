# Performance & tuning notes

Target: 60 FPS on a mid-range desktop GPU at 1080p (High preset); playable (30–60 FPS)
on recent phones (Low/Medium presets).

## Quality tiers (`src/game/core/Settings.ts` → `resolveQuality`)
| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Render scale | 0.7 | 0.85 | 1.0 | 1.0 |
| Shadow map | 1024 | 2048 | 4096 | 4096 |
| GTAO | off | off | on | on |
| Bloom / speed blur | on / off | on / on | on / on | on / on |
| Reflections (env intensity) | low | mid | full | full |
| Particle budget | 600 | 1500 | 3500 | 6000 |
| Draw distance | 400 m | 650 m | 1000 m | 1400 m |
| Prop density | 0.4 | 0.7 | 1.0 | 1.25 |
| Anti-aliasing | none | FXAA | SMAA | SMAA |

`auto` picks a tier from a GPU heuristic (`detectGpuTier`) and device class.

## Dynamic scaling
`QualityManager` watches smoothed frame time: >22 ms for 2.5 s lowers the render scale by
0.1 (floor 0.55); <15.5 ms for 8 s raises it by 0.05. The composer render targets follow
the drawing-buffer size every frame.

## Where the time goes (High preset, 13 cars)
* Physics: ~1–1.5 ms per step — 14 raycast vehicles (56 rays), static trimeshes.
* Scenery: instanced meshes per 120 m chunk; chunks beyond the draw distance are hidden
  (`TrackProps.updateVisibility`). Buildings/trees near the road carry colliders, distant
  ones are visual only.
* Post: GTAO is the most expensive pass (~2–3 ms at 1080p); bloom ~1 ms; SMAA ~0.7 ms.
* Shadows: one directional light, frustum biased ahead of the camera; 4096² PCF-soft.
* Particles: CPU update is O(budget); keep budgets ≤ 6000.
* Audio: one engine voice (5–7 oscillators + noise) per car; voices beyond 140 m are
  muted and skipped.

## Memory
* Textures are generated on demand at `textureScale × base size` and released with
  `TextureFactory.releaseUnused()` on track unload (streaming-style cache).
* Every track object is tracked in a disposables list; `BuiltTrack.dispose()` frees
  geometry/materials and Rapier bodies are removed via `PhysicsWorld.removeBody`.
* Replay buffers are fixed-size ring buffers (10 min × 14 cars ≈ 4.7 MB).
* Photos are stored as ≤1280 px JPEGs, max 12, to respect the ~5 MB `localStorage` budget.

## Mobile notes
* Touch layout (buttons / tilt / wheel) in Options → Controls; HUD scale and safe-area
  insets are honoured.
* `Low` disables speed blur, GTAO and high-detail AI bodies; AI cars use the low-poly LOD
  beyond 120 m.
* Keep the pixel ratio ≤ 2 (enforced) — retina phones otherwise render 3× the pixels.

## Known trade-offs / ideas
* Rapier trimesh terrain (≈ 220² cells) costs ~200 ms to build on load; a heightfield
  collider would be faster but needs careful orientation handling.
* GTAO could run at half resolution for a ~2× saving on the pass.
* AI drivers update once per render frame; at very low frame rates their reaction time
  grows. Moving AI into the fixed step (or a worker) would make them frame-rate independent.
