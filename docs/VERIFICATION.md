# Apex Overdrive 2.0 — verification record

13 October 2026. Product copy: `/Users/bello/work/Dev/products/apex`, branch
`product/overdrive-2`, based on original commit `5455d33`. The original repository
was left unchanged. No remote, push, or deployment was created.

Environment: macOS 27.0, Node 22.23.2, Chrome 155.0.8059.40. The installed catalog
contains 17 cars and 18 selectable layouts (2.1 removed six cars and the drift circuit whose model licenses did not allow redistribution), including the Sepang Fam Jam variant.

## Run it

Double-click `Start Apex.command`, or run `npm start` after building. The stable
local address is `http://127.0.0.1:4173`. Choose **Race → Open Driving → Fam Jam**
for a solo practice drive with family billboards. Choose **Two players** for local
split screen; each player can select a different car. All cars are available in
race setup; career ownership and garage progression remain separate.

For wheels, use **Options → Controls → Wheels & controllers**. Calibrate steering
and pedals, assign each device to a player, and choose automatic or manual gears.
See [CONTROLLERS.md](CONTROLLERS.md) for the two-wheel workflow and hardware limits.

## Corrected causes and behavior

- **Suspension instability:** the original 60 Hz integration could launch a formula
  car on an empty, flat road. Physics now advances at 120 Hz, independent of rendering.
  Ground meshes correct internal triangle edges. Wheel rays reject walls and undersides;
  teleporting clears stale suspension and motion state. Manual reverse remains selected.
- **Invisible raised surfaces:** ice/water sensors follow the actual curved road;
  procedural crests share their visible and physical mesh without a vertical entry lip.
  Suzuka's lower road is no longer crossed by a generated grass support sheet.
  Indianapolis gap repair preserves banking instead of propagating a raised edge across
  the lane. Marina's visible painted apex patches now support the car physically.
- **Imported route safety:** asphalt corridor selection and car-footprint clearance
  keep AI routes and grid slots clear of model walls, pit dividers and cones. AI reversing
  now exceeds the gearbox's engagement threshold and gives a trapped car time to back out.
- **Race lifecycle:** sprint races finish at the final required checkpoint; countdown
  movement does not score. Quick and sprint tests drive a real complete race. Canceled
  series are cleared; championships retain their opponents, knockout grids retain only
  survivors, and final standings use round results. Replay controls are visible after
  results; pause, restart, photo capture and exit are covered through the UI.
- **Controllers:** independent profiles and assignments work for two devices with the
  same ID. Steering center, travel, curve, inversion, axis/button pedals and action
  bindings are configurable. A disconnect clears held inputs and pauses the session.
- **Persistence/content:** fresh and existing profiles derive eligible track unlocks
  from the catalog. Save imports merge current settings defaults; quota fallback reads
  the latest in-memory data. Typed local content packs validate atomically before
  extending the shared catalogs. See [EXTENDING.md](EXTENDING.md).
- **Loading/resources:** physics loads on the first race, circuit downloads show progress,
  and circuit model resources/colliders are released on exit. Tests start their own server
  and locate Chrome across supported desktop paths. The former mock online hub now
  describes the available local modes honestly.

## Automated verification

`npm run check` passed: TypeScript, ESLint, the production build, all 13 regression
suites and the compiled production smoke test. Asset validation passed; every
checked asset is within its configured budget.

`npm run check` runs TypeScript, ESLint, the production build, 13 regression suites,
and the production smoke test. `npm run assets:validate` checks asset budgets/formats.

| Suite | Coverage |
|---|---|
| Physics | Every catalog car: 40 simulated seconds at full throttle on segmented flat ground, upright/vertical-motion bounds, and manual reverse |
| Hazards | Ice and fountain: 87 probes each on curved/sloped ground, within 5.1 mm of the visible road; disabled hazards remove support |
| Controllers | 11 pure synthetic-device regressions, including two identical wheel IDs and disconnect/reload behavior |
| AI | Reverse engagement/recovery, perfect-consistency driving, reproducible decisions in simulation time |
| Modes | All 10 start/countdown/results/exit paths; real quick and sprint completion; required-checkpoint rules; all championship/knockout rounds and surviving rosters |
| Game lifecycle | Unlocks, content registration, import defaults, quota fallback, deferred physics, pause/resume, restart, disconnect, disposal, photo capture and replay |
| UI flow | Menu screens, family-track and both-car selection, keyboard driving, restart and exit |
| Driving audit | W13 on all 19 layouts in clear/dry conditions: signed net route progress, no flips and no recovery resets |
| Road surfaces | 50 visible-vs-physical samples at Indianapolis banking, Suzuka underpass and Marina apexes; worst measured difference 6 mm |
| Collider audit | Drivable-band probes across all runtime catalog layouts, invisible obstacles and session disposal |
| Wheel calibration | Real UI with two synthetic identical G29 devices, independent profiles, reload, pedals, paddles, camera, pause and disconnect |
| Split screen | Stacked and side-by-side views, separate input routing, HUDs, cockpit cameras and frame rate |
| Billboards | Placement, image loading, rotation, captions, camera framing, collider safety, texture disposal, missing-photo fallback and frame-rate budget |
| Production smoke | Compiled build: menu defers Rapier, debug hook absent, Fam Jam photos load, W13 drives by keyboard, pause/exit, no runtime errors or missing assets |

The final full-catalog run recorded zero flips and zero recovery resets on every
layout. Collider probes recorded zero invisible obstacles and zero detected steps.
Visible designed hazards/barriers are reported separately; their presence does
not mean all scenery is safe to drive through.

Both split-screen layouts measured approximately 61 fps in headless software GL.
The uncapped six-second billboard comparison measured 260 fps on plain Sepang and
244 fps on Fam Jam, within the enforced 10% regression budget. Fam Jam placed 19
of its 24 candidate boards, showed all 31 photos during rotation, and released all
photo/caption textures when the session ended. Screenshots and the final command
logs are kept locally in the ignored `tests/shots/` directory.

Driving coverage is a reproducible regression scenario, not a claim that every
car/weather/traffic/assist combination has been exhaustively tested. The all-car
flat-road test complements the W13 circuit runs. Visible crashes can still roll a car;
this build addresses the identified unintended launches rather than disabling physics.

## Family assets and privacy

SHA-256 comparison against the original found no differences in any of the 32 files
under `public/assets/photos`, 32 under `assets-src/photos`, or 36 under
`public/assets/models`. The optimized set contains 31 family photographs plus its
manifest. Raw downloads and family photographs remain gitignored.

UUID photo names intentionally produce no caption strips. Rename raw files to meaningful
names and run `npm run assets:photos` to create captions. The placement rules continue to
reject unsafe billboard slots. The compiled `dist/` includes the local photos; publishing
that directory would publish them. Nothing was uploaded by this build.

## Remaining limits

- No physical wheel was available. Input is tested with synthetic consumer-wheel devices;
  macOS/Chrome exposure of any purchased model still needs a hardware check. No wheel
  force feedback, clutch/H-pattern gearbox, or wheel-display output is implemented.
  Gamepad indices distinguish identical devices; reassign after an OS/browser reordering.
- No online multiplayer service exists. Local split-screen works without a backend.
- Yas Marina remains outside the catalog. Point extraction succeeds, but the source asset
  has missing/overlapping road geometry around its tunnel/start area. It needs asset repair
  before being offered as a supported layout.
- Circuit GLBs still load whole. Progress reporting and resource release improve this
  path, but geometric streaming/LOD and a physics worker are not implemented.
- Production dependency audit reports **0 vulnerabilities**. The full developer-tool
  audit reports 12 high advisories in the asset/test tooling dependency graph. Available
  automatic fixes require major changes or downgrades; they were not forced into the
  validated pipeline. Keep untrusted archives out of that tooling until upstream fixes
  are adopted. The remaining findings are recorded by `npm audit`.
- Production output is approximately 367 MB including models, HDRI, transcoders and
  local family photos. The deferred Rapier chunk remains 761 KB gzip; the menu no longer
  requests it before a race.

The copied [HANDOFF.md](../HANDOFF.md) is the historical source audit. This record,
current code and runnable tests supersede its old counts, open bugs and commands.
