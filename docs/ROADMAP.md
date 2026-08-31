# Roadmap & ideas for future additions

## Online (the contracts are in `src/game/net`)
* **Authoritative server** — WebSocket lobby + UDP/WebRTC data channel for state sync.
  Replace `LocalNetworkProvider` with a remote implementation; the replay sample format
  (`[x,y,z,qx,qy,qz,qw]` at 20 Hz) doubles as a network snapshot format with
  interpolation already implemented in `Replay.ts`.
* **Matchmaking** by rating band (`RatingService.report` already computes Elo deltas).
* **Invite-only rooms** with the existing room codes; host migration.
* **Voice** — `VoiceService` detects `getUserMedia`; wire WebRTC audio tracks + a
  push-to-talk key.
* **Cloud saves** — implement `CloudStorageAdapter.push/pull` and call
  `saveManager.setAdapter()` after sign-in; the profile is a single versioned document
  with `updatedAt` for conflict resolution.
* **Global leaderboards & downloadable ghosts** — `GhostService` already serialises laps.

## Gameplay
* Pit strategy UI for endurance (tyre compounds wear, fuel loads).
* Split-screen / hot-seat time attack.
* Track editor: `TrackDefinition` is pure data — a spline editor could author new layouts.
* Livery editor with decal layers and sharing codes.
* Rival storylines and radio chatter in career events.
* Weekly community events seeded from the challenge system.

## Rendering
* Screen-space reflections for wet roads (SSRPass is available in three's examples).
* Cascaded shadow maps for large draw distances.
* Motion-vector based per-object motion blur (wheels, other cars).
* Volumetric fog / god rays through tunnels and trees.
* Skinned crowd animations, animated flags.
* Real car models via the asset pipeline (glTF + KTX2).

## Physics
* Tyre temperature and wear affecting grip over long races.
* Deformable barriers (tyre walls) and debris physics.
* Suspension geometry (camber/toe) and adjustable setups per track.

## Audio
* Sampled engine notes layered with the synth for extra realism.
* Reverb zones (tunnels, grandstands) via convolver presets.
* Commentary / engineer callouts.

## Platform
* PWA manifest + service worker for offline play and home-screen install.
* WebGPU renderer (three's `WebGPURenderer`) once broadly available.
* Web Worker physics (Rapier runs in workers) to decouple simulation from rendering.
