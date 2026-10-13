# Physics & handling model

All vehicles share `VehicleController` (`src/game/physics/VehicleController.ts`): one
Rapier dynamic rigid body (a cuboid chassis with explicit mass properties and a low
centre of mass) plus four virtual wheels simulated by raycasts. Everything below runs
at a fixed 120 Hz.

## Per step

1. **Steering** — input × available lock. Lock is limited by speed so that full input
   asks for at most ~`1.35·grip·g` of lateral acceleration (`steeringLimit()`), with
   extra lock while sliding so slides can be caught. Response rate and damage wobble
   applied. Calibrated direct wheel input uses full lock and bypasses steering
   smoothing; optional ESC still adds counter-steer and cuts throttle beyond ~9° of yaw slip.
2. **Drivetrain** — automatic reverse engagement (brake held at standstill for 0.35 s), automatic
   shifting decided on road speed (never on spinning wheels), rev limiter, torque
   curve (ICE peak curve / EV constant-power / hybrid blend), turbo spool with blow-off
   events, supercharger (linear with rpm), nitrous multiplier, fuel burn, damage power
   loss, engine braking / EV regen. Manual reverse stays selected until a shift.
   Torque is split by drivetrain and rear bias.
3. **Wheel raycasts** — from an attachment point inside the chassis down the chassis
   up-axis, length = rest length + radius. The hit collider's metadata gives the
   surface type. Rays support only against ground and reject wall/underside normals.
   Touchdown snaps wheel speed to road speed.
4. **Suspension** — spring `k·x` + damper (separate compression/rebound rates), bump
   stop past travel, surface roughness noise, anti-roll bars per axle; force applied at
   the attachment point along the contact normal.
5. **Tyres** — per wheel:
   * longitudinal slip uses an *implicit Euler* wheel integrator (stable at low speed);
     past the peak an explicit update lets wheelspin / lock-up run away naturally;
   * brakes are friction torques that cannot reverse the wheel; ABS holds the wheel at
     peak slip; TCS cuts torque when driven slip passes 1.4× peak; handbrake adds a
     large torque to the rear axle;
   * lateral force from slip angle through the same magic-formula-style curve
     (`tireCurve` in `TireModel.ts`), limited so it never overshoots at crawling speed;
   * combined slip via a friction ellipse — throttle and brake steal cornering grip and
     locked/spinning wheels lose lateral authority first;
   * rolling resistance and off-surface drag.
6. **Aero** — quadratic drag at the centre of mass, front/rear downforce at the axles,
   soft top-speed limiter matching the design figure.
7. **Airborne / rollover** — angular damping in the air; upside-down or beached for a
   few seconds flags `needsRespawn`.

Load transfer, body roll, pitch under braking, lift-off oversteer, handbrake turns and
drifts all emerge from the interaction of these parts — nothing is scripted.

## Damage
Rapier contact-force events are scaled by mass (`force / (mass·400)`), squared, and
accumulate into `damage ∈ [0,1]`. Effects: power −45 % at full damage, slower steering
response, steering pull, weaker brakes, red vignette. Bodywork is dented by displacing
vertices near the impact point (`CarMeshBuilder.dent`). Repairs: pit lane (endurance),
pause menu (credits), garage.

## Surfaces & weather
Ground triangle meshes use internal-edge correction. Imported road repairs follow
the visible surface and preserve banking; overpass surfaces are not bridged into
the road below. Ice/water sensors and procedural crests use the same curved mesh
for visuals and collision support, avoiding invisible flat shelves on slopes.

`Surfaces.ts` defines grip, rolling resistance, drag and particle type per surface.
Weather multiplies grip: wet −28 % on tarmac (less with rally/winter tyres), snow cover
blends toward the snow coefficient, ice toward 0.22. Tyre compounds (cosmetic choice in
the garage) change grip, loose-surface grip and wet/snow behaviour; wings change
downforce and drag.

## Tuning knobs (per car, `VehicleCatalog.ts`)
| Group | Fields | Effect |
|---|---|---|
| mass / comHeight | | inertia, load transfer, rollover threshold |
| engine | maxTorque, peakRpm, redline, turboGain, turboSpool | power delivery, boost lag |
| gearbox | ratios, finalDrive, shiftTime, drivetrain, rearBias | acceleration, traction split |
| suspension | stiffness, damping (comp/rebound), restLength, travel, antiRoll | ride, roll, kerb behaviour |
| tires | gripFront/Rear, peakSlipAngle/Ratio, falloff, rollingResistance | balance (under/oversteer), snappiness, drift |
| brakes | maxTorque, frontBias, handbrakeTorque | stopping, lock-up bias |
| aero | dragCoefficient, frontalArea, downforceFront/Rear | top speed, high-speed grip |
| steering | maxAngle, speedSensitivity, responseRate | lock, high-speed stability, feel |

Rules of thumb: more rear grip than front = stable/understeer; `falloff` close to 1 =
forgiving slides (drift car), ~0.7 = snap oversteer (track car); `downforce/mass` above
~1e-3 means grip grows strongly with speed (prototype).
