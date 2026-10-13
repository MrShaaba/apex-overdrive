# Extending Apex Overdrive

Keep track and vehicle definitions in typed local packs. Register packs before
the engine boots in `src/game/content/installed.ts`. The same catalogs feed race
setup, garage entries, fresh-profile unlocks, and the collider audit.

```ts
import { TRACK_BY_ID } from '../tracks/TrackCatalog'
import type { ContentPack } from './ContentRegistry'

export const familyEvening: ContentPack = {
  id: 'family-evening',
  tracks: [{
    ...TRACK_BY_ID['sepang'],
    id: 'sepang-evening',
    name: 'Sepang Evening',
    environment: {
      ...TRACK_BY_ID['sepang'].environment,
      defaultHour: 18,
    },
    photoBillboards: { count: 24 },
  }],
}
```

Import this pack into `installed.ts` and add it to `packs`. Registration validates
IDs, finite coordinates, widths, required physics dimensions, and asset credits
before changing either catalog. A bad pack throws without partially installing.
Packs are local TypeScript content, not an executable download/mod marketplace.

## Tracks and family pictures

`TrackDefinition` is data: metre coordinates, a closed/open layout, environment,
and features positioned at normalized spline parameters from 0 to 1. A model
reference is optional. Model tracks use the existing preparation pipeline; do not
replace its road/terrain/wall classification with a single scenery collider.

The runtime repairs imported centreline clearance against the actual asphalt,
then measures wall clearance for safe AI lanes and grid positions. Inspect a new
track visually and drive it; a generated line alone is not proof of safety.
Use `npm test -- collider-audit driving-audit` for surface and driving coverage;
both discover layouts from the runtime catalog. Deliberate jumps/hazards need
their own expected behavior checks.

Family photos live in ignored `assets-src/photos/fam-jam/`. Run `npm run assets:photos`
to regenerate the ignored optimized photos and manifest. UUID filenames have no
caption; human-readable filenames create captions. A variant with `photoBillboards`
reuses the track model and placement safety rules. Run `npm test -- billboards`
after changing placement, texture handling, or the underlying circuit.

## Vehicles and controls

Use `VehicleSpec` for mass, tyres, suspension, aero, gearing, body dimensions, and
optional licensed model metadata. The car pipeline preserves +Z forward, metres,
ground at y=0, `body`, and `wheel_0..3` rigs. Keep the attribution with every model.
The procedural car remains the fallback when a model cannot load.

Physics advances at 120 Hz with bounded catch-up. Suspension rays only support
against driveable ground; chassis collisions still hit walls, props, and other
cars. Ground triangle meshes use Rapier's internal-edge correction. New specs
automatically enter the flat-road acceleration/reverse regression. Add cornering
and curb scenarios when changing suspension or tyre behavior.

Input devices are calibrated and assigned independently of vehicle models.
`Gamepads` normalizes raw channels; `InputManager` routes each player's input and
discrete actions. Extend those layers for a new input transport rather than
reading hardware directly from `VehicleController`. See [controllers](CONTROLLERS.md).

## Engine, persistence, and ownership

React uses `GameStore` for state and `EventBus` for discrete events. Avoid adding
per-frame React updates or UI imports inside physics. Put new race rules in the
gameplay layer. `StorageAdapter` is the persistence boundary; add schema migrations
and preserve old saves when changing profile data.

Every created object needs an owner. A track owns its physics scope, geometry,
materials, billboard registrations, and disposal callback. Release those on both
normal exit and failed loading. Shared car templates belong to `ModelLibrary`;
instance materials belong to each car. Session teardown must leave zero colliders.

Online transport contracts are present in `game/net`, but there is no online
service. A future transport needs real synchronization and session tests before
it can be exposed as a playable mode.
