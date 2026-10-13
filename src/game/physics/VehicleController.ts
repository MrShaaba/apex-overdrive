/**
 * Raycast vehicle controller.
 *
 * A single Rapier dynamic rigid body (the chassis) with four virtual wheels.
 * Every fixed step each wheel:
 *   1. casts a ray down its suspension axis to find the ground + surface type
 *   2. computes spring/damper force (with bump stops and anti-roll bars)
 *   3. computes tyre longitudinal slip with an implicit-Euler wheel integrator
 *      (stable at low speed, natural wheelspin / lock-up past the peak)
 *   4. computes lateral slip-angle force through the same magic-formula curve
 *   5. clamps both with a friction ellipse so throttle/brake steal cornering grip
 *   6. applies everything as forces at the contact patch — load transfer, body
 *      roll, pitch under braking and handbrake slides all emerge from this.
 *
 * On top of the wheels: engine torque curve, turbo spool/blow-off, gearbox with
 * auto/manual shifting, nitrous, fuel, aerodynamic drag + downforce, a soft top
 * speed limiter, driver aids (ABS/TCS/ESC) and mechanical damage effects.
 */

import * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import type { PhysicsWorld } from './PhysicsWorld'
import { frictionEllipse, tireCurve } from './TireModel'
import { CollisionGroup, effectiveGrip, makeGroups, SURFACES, type SurfaceType, type WeatherGripState } from './Surfaces'
import { cosmeticModifiers, type CosmeticPhysicsModifiers, type VehicleCustomization, type VehicleSpec } from '../vehicles/VehicleSpec'
import { clamp, clamp01, damp, degToRad, sign } from '../core/MathUtils'

export interface VehicleInput {
  steer: number
  /** Calibrated wheel: linear steering rack, without gamepad speed assistance. */
  directSteering?: boolean
  throttle: number
  brake: number
  handbrake: boolean
  boost: boolean
}

export interface VehicleAssists {
  abs: boolean
  tcs: boolean
  esc: boolean
  autoTransmission: boolean
}

export interface WheelState {
  index: number
  isFront: boolean
  isLeft: boolean
  isDriven: boolean
  attachLocal: THREE.Vector3
  radius: number
  width: number
  steerAngle: number
  compression: number
  prevCompression: number
  contact: boolean
  contactPoint: THREE.Vector3
  contactNormal: THREE.Vector3
  hubWorld: THREE.Vector3
  surface: SurfaceType
  angularVelocity: number
  rotation: number
  load: number
  slipRatio: number
  slipAngle: number
  saturation: number
  longForce: number
  latForce: number
  locked: boolean
  spinning: boolean
  skid: number
  suspensionForce: number
  velocityLong: number
  velocityLat: number
}

export interface VehicleTelemetry {
  speed: number
  speedKmh: number
  rpm: number
  gear: number
  throttle: number
  brake: number
  turboBoost: number
  nitro: number
  nitroActive: boolean
  /** True while the ERS battery is recharging from braking or coasting. */
  harvesting: boolean
  fuel: number
  damage: number
  engineTorque: number
  airborne: boolean
  driftAngle: number
  drifting: boolean
  gLat: number
  gLong: number
  steerAngle: number
  wheelsOnGround: number
  powerFactor: number
  limiter: boolean
  shifting: boolean
  onLooseSurface: boolean
  wet: number
  topSpeedKmh: number
}

const RHO_AIR = 1.225
const WHEEL_INERTIA = 1.6
const FILTER_GROUPS = makeGroups(CollisionGroup.VEHICLE, CollisionGroup.GROUND)

/**
 * Steering lock available at a given speed (radians). Lock is limited so a full
 * input asks for at most ~`aLatCap` of lateral acceleration (more when the car is
 * already sliding so the driver can catch it). Shared with the AI so both sides
 * agree on what "full steering" means at speed.
 */
export function steeringLimit(spec: VehicleSpec, speed: number, driftAngle: number): number {
  const maxAngle = degToRad(spec.steering.maxAngle)
  const grip = (spec.tires.gripFront + spec.tires.gripRear) * 0.5
  const aLatCap = 9.81 * grip * (1.35 - spec.steering.speedSensitivity * 0.5)
  const v = Math.max(3, Math.abs(speed))
  let lock = Math.atan((spec.body.wheelbase * aLatCap) / (v * v))
  lock = Math.max(degToRad(2.5), lock)
  if (Math.abs(driftAngle) > 0.25) lock = Math.max(lock, maxAngle * 0.7)
  return Math.min(maxAngle, lock)
}

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _up = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _linvel = new THREE.Vector3()
const _angvel = new THREE.Vector3()
const _steerQ = new THREE.Quaternion()
const _vel = new THREE.Vector3()
const _force = new THREE.Vector3()
const _rayDir = new THREE.Vector3()
const _origin = new THREE.Vector3()

export class VehicleController {
  readonly body: RAPIER.RigidBody
  readonly collider: RAPIER.Collider
  readonly wheels: WheelState[] = []
  readonly telemetry: VehicleTelemetry
  spec: VehicleSpec
  private mods: CosmeticPhysicsModifiers
  readonly id: number

  /** External tuning knobs (AI catch-up, difficulty). */
  gripScale = 1
  powerScale = 1

  // Drivetrain state
  gear = 1
  private shiftTimer = 0
  private reverseDwell = 0
  private rpm = 900
  private turboBoost = 0
  private nitro: number
  private fuel: number
  private damage = 0
  private limiterFlicker = 0
  private lastThrottle = 0
  private prevVelocity = new THREE.Vector3()
  private upsideDownTime = 0
  private airborneTime = 0
  private beachedTime = 0
  private steerDamageOffset = 0
  private lastSteerAngle = 0
  private readonly rayLength: number
  private readonly frontAxleZ: number
  private readonly rearAxleZ: number
  private wheelTorque: number[] = [0, 0, 0, 0]

  /** Previous-step transform for render interpolation. */
  readonly prevPosition = new THREE.Vector3()
  readonly prevQuaternion = new THREE.Quaternion()
  readonly position = new THREE.Vector3()
  readonly quaternion = new THREE.Quaternion()
  readonly velocity = new THREE.Vector3()
  readonly forward = new THREE.Vector3(0, 0, 1)
  readonly up = new THREE.Vector3(0, 1, 0)

  /** Set by the owning entity when a big impact happens. */
  onGearChange: ((gear: number, up: boolean) => void) | null = null
  onTurboBlowoff: ((pressure: number) => void) | null = null

  needsRespawn = false
  weather: WeatherGripState = { wetness: 0, snowCover: 0, iceCover: 0 }
  assists: VehicleAssists = { abs: true, tcs: true, esc: false, autoTransmission: true }
  fuelEnabled = true
  damageEnabled = true
  /** Automatic speed limiter (km/h) while in the pit lane; null = off. */
  speedLimitKmh: number | null = null
  /** DRS open: less drag and rear downforce, a little extra top speed. */
  drsActive = false

  constructor(
    private readonly physics: PhysicsWorld,
    spec: VehicleSpec,
    id: number,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    customization?: VehicleCustomization,
  ) {
    this.spec = spec
    this.id = id
    this.mods = customization ? cosmeticModifiers(customization) : cosmeticModifiers({ tires: 'sport', wing: 'none', bumper: 'stock' } as VehicleCustomization)
    this.nitro = spec.performance.nitroCapacity
    this.fuel = spec.performance.fuelCapacity
    const R = physics.RAPIER
    const b = spec.body

    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w })
      .setLinearDamping(0.02)
      .setAngularDamping(1.2)
      .setCcdEnabled(true)
      .setCanSleep(false)
    this.body = physics.world.createRigidBody(bodyDesc)

    // Chassis box. Local origin = centre of mass (at `comHeight` above rest ground).
    const boxHalf = { x: b.width * 0.5 * 0.92, y: (b.height - b.groundClearance) * 0.5 * 0.9, z: b.length * 0.5 * 0.96 }
    const boxCenterY = -spec.comHeight + b.groundClearance + boxHalf.y + 0.02
    const colliderDesc = R.ColliderDesc.cuboid(boxHalf.x, boxHalf.y, boxHalf.z)
      .setTranslation(0, boxCenterY, 0)
      .setDensity(0)
      .setFriction(0.25)
      .setRestitution(0.05)
      .setCollisionGroups(makeGroups(CollisionGroup.VEHICLE, CollisionGroup.ALL))
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(spec.mass * 4)
    this.collider = physics.world.createCollider(colliderDesc, this.body)
    physics.registerCollider(this.collider, { vehicleId: id })

    const m = spec.mass
    const ix = (m / 12) * (b.height * b.height + b.length * b.length) * 1.15
    const iy = (m / 12) * (b.width * b.width + b.length * b.length) * 1.05
    const iz = (m / 12) * (b.width * b.width + b.height * b.height) * 1.4
    this.body.setAdditionalMassProperties(m, { x: 0, y: 0, z: 0 }, { x: ix, y: iy, z: iz }, { x: 0, y: 0, z: 0, w: 1 }, true)

    // Wheel geometry: rays start above the hub inside the chassis.
    const s = spec.suspension
    const staticComp = clamp((m * 9.81) / 4 / s.stiffness, 0.02, s.travel * 0.7)
    const attachY = b.wheelRadius - spec.comHeight + s.restLength - staticComp
    this.rayLength = s.restLength + b.wheelRadius
    this.frontAxleZ = b.wheelbase * 0.5
    this.rearAxleZ = -b.wheelbase * 0.5
    const half = b.trackWidth * 0.5
    const drivetrain = spec.gearbox.drivetrain
    const defs: [number, number, boolean, boolean][] = [
      [-half, this.frontAxleZ, true, true],
      [half, this.frontAxleZ, true, false],
      [-half, this.rearAxleZ, false, true],
      [half, this.rearAxleZ, false, false],
    ]
    defs.forEach(([x, z, isFront, isLeft], i) => {
      this.wheels.push({
        index: i,
        isFront,
        isLeft,
        isDriven: drivetrain === 'AWD' || (drivetrain === 'RWD' && !isFront) || (drivetrain === 'FWD' && isFront),
        attachLocal: new THREE.Vector3(x, attachY, z),
        radius: b.wheelRadius,
        width: b.wheelWidth,
        steerAngle: 0,
        compression: staticComp,
        prevCompression: staticComp,
        contact: false,
        contactPoint: new THREE.Vector3(),
        contactNormal: new THREE.Vector3(0, 1, 0),
        hubWorld: new THREE.Vector3(),
        surface: 'asphalt',
        angularVelocity: 0,
        rotation: 0,
        load: 0,
        slipRatio: 0,
        slipAngle: 0,
        saturation: 0,
        longForce: 0,
        latForce: 0,
        locked: false,
        spinning: false,
        skid: 0,
        suspensionForce: 0,
        velocityLong: 0,
        velocityLat: 0,
      })
    })

    this.telemetry = {
      speed: 0,
      speedKmh: 0,
      rpm: spec.engine.idleRpm,
      gear: 1,
      throttle: 0,
      brake: 0,
      turboBoost: 0,
      nitro: this.nitro,
      nitroActive: false,
      harvesting: false,
      fuel: this.fuel,
      damage: 0,
      engineTorque: 0,
      airborne: false,
      driftAngle: 0,
      drifting: false,
      gLat: 0,
      gLong: 0,
      steerAngle: 0,
      wheelsOnGround: 4,
      powerFactor: 1,
      limiter: false,
      shifting: false,
      onLooseSurface: false,
      wet: 0,
      topSpeedKmh: spec.performance.topSpeed,
    }
    this.readTransform()
    this.prevPosition.copy(this.position)
    this.prevQuaternion.copy(this.quaternion)
  }

  /** Swap the tuned spec (after upgrades) without recreating the body. */
  setSpec(spec: VehicleSpec, customization?: VehicleCustomization): void {
    this.spec = spec
    if (customization) this.mods = cosmeticModifiers(customization)
    this.telemetry.topSpeedKmh = spec.performance.topSpeed
  }

  // ---------------------------------------------------------------------------
  // Public helpers
  // ---------------------------------------------------------------------------

  private readTransform(): void {
    const t = this.body.translation()
    const r = this.body.rotation()
    this.position.set(t.x, t.y, t.z)
    this.quaternion.set(r.x, r.y, r.z, r.w)
    const lv = this.body.linvel()
    this.velocity.set(lv.x, lv.y, lv.z)
    this.forward.set(0, 0, 1).applyQuaternion(this.quaternion)
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion)
  }

  private hold: 'free' | 'settle' | 'hold' = 'free'

  /** Grid state: 'settle' (only vertical motion, onto the springs), 'hold' (pinned), 'free'. */
  get holdMode(): 'free' | 'settle' | 'hold' {
    return this.hold
  }

  get isHeld(): boolean {
    return this.hold === 'hold'
  }

  /**
   * Start-grid restraint. 'settle' lets the car drop onto its suspension but nothing else —
   * no creeping down a cambered grid, no nudges from a neighbour — 'hold' pins it at rest
   * until the lights go out, and 'free' hands it back to the engine with zero velocity so
   * nothing but its own power moves it at the start.
   */
  setHold(mode: 'free' | 'settle' | 'hold'): void {
    if (this.hold === mode) return
    this.hold = mode
    const b = this.body
    if (mode === 'settle') {
      b.setEnabledTranslations(false, true, false, true)
      b.setEnabledRotations(true, false, true, true)
    } else if (mode === 'hold') {
      b.setEnabledTranslations(false, false, false, true)
      b.setEnabledRotations(false, false, false, true)
      b.setLinvel({ x: 0, y: 0, z: 0 }, true)
      b.setAngvel({ x: 0, y: 0, z: 0 }, true)
      this.velocity.set(0, 0, 0)
    } else {
      b.setEnabledTranslations(true, true, true, true)
      b.setEnabledRotations(true, true, true, true)
      b.setLinvel({ x: 0, y: 0, z: 0 }, true)
      b.setAngvel({ x: 0, y: 0, z: 0 }, true)
    }
  }

  teleport(position: THREE.Vector3, quaternion: THREE.Quaternion, keepSpeed = 0): void {
    this.setHold('free')
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true)
    this.body.setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }, true)
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).multiplyScalar(keepSpeed)
    this.body.setLinvel({ x: fwd.x, y: fwd.y, z: fwd.z }, true)
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    for (const w of this.wheels) {
      w.angularVelocity = keepSpeed / w.radius
      w.compression = w.prevCompression = 0
      w.contact = false
      w.load = w.suspensionForce = 0
      w.locked = w.spinning = false
    }
    this.gear = 1
    this.shiftTimer = 0
    this.reverseDwell = 0
    this.airborneTime = 0
    this.lastSteerAngle = 0
    this.prevVelocity.copy(fwd)
    this.upsideDownTime = 0
    this.beachedTime = 0
    this.needsRespawn = false
    this.readTransform()
    this.prevPosition.copy(this.position)
    this.prevQuaternion.copy(this.quaternion)
  }

  shiftUp(): void {
    if (this.gear < this.spec.gearbox.ratios.length && this.shiftTimer <= 0) {
      this.gear = this.gear <= 0 ? 1 : this.gear + 1
      this.shiftTimer = this.spec.gearbox.shiftTime
      this.onGearChange?.(this.gear, true)
    }
  }

  shiftDown(): void {
    if (this.shiftTimer > 0) return
    if (this.gear > 1) {
      this.gear--
      this.shiftTimer = this.spec.gearbox.shiftTime
      this.onGearChange?.(this.gear, false)
    } else if (this.gear === 1 && Math.abs(this.telemetry.speed) < 2) {
      this.gear = -1
      this.onGearChange?.(this.gear, false)
    }
  }

  applyDamage(amount: number): void {
    if (!this.damageEnabled) return
    this.damage = clamp01(this.damage + amount)
    this.steerDamageOffset = (Math.random() - 0.5) * this.damage * 0.06
  }

  repair(fraction = 1): void {
    this.damage = clamp01(this.damage - fraction)
    if (this.damage <= 0.001) {
      this.damage = 0
      this.steerDamageOffset = 0
    }
  }

  refuel(liters?: number): void {
    this.fuel = liters === undefined ? this.spec.performance.fuelCapacity : Math.min(this.spec.performance.fuelCapacity, this.fuel + liters)
  }

  addNitro(amount: number): void {
    this.nitro = clamp(this.nitro + amount, 0, this.spec.performance.nitroCapacity)
  }

  setDamage(d: number): void {
    this.damage = clamp01(d)
  }

  getDamage(): number {
    return this.damage
  }

  getNitroFraction(): number {
    return this.nitro / this.spec.performance.nitroCapacity
  }

  getFuelFraction(): number {
    return this.fuel / this.spec.performance.fuelCapacity
  }

  // ---------------------------------------------------------------------------
  // Fixed-step simulation
  // ---------------------------------------------------------------------------

  /** Must be called before every physics step. */
  step(dt: number, input: VehicleInput): void {
    this.prevPosition.copy(this.position)
    this.prevQuaternion.copy(this.quaternion)
    this.readTransform()
    const body = this.body
    body.resetForces(true)
    body.resetTorques(true)

    const spec = this.spec
    const av = body.angvel()
    _angvel.set(av.x, av.y, av.z)
    _linvel.copy(this.velocity)
    _pos.copy(this.position)
    _q.copy(this.quaternion)
    _up.copy(this.up)
    _fwd.copy(this.forward)
    _right.crossVectors(_up, _fwd).normalize()

    const speed = _linvel.length()
    const forwardSpeed = _linvel.dot(_fwd)
    const t = this.telemetry

    // --- Steering -----------------------------------------------------------
    const driftAngle = speed > 4 ? Math.atan2(_linvel.dot(_right), Math.max(0.5, Math.abs(forwardSpeed))) : 0
    const maxSteer = input.directSteering ? degToRad(spec.steering.maxAngle) : steeringLimit(spec, forwardSpeed, driftAngle)
    let steerTarget = input.steer * maxSteer + this.steerDamageOffset * maxSteer

    // Electronic stability control: countersteer when the car yaws past the driver's intent.
    let escThrottleCut = 1
    if (this.assists.esc && speed > 8 && Math.abs(driftAngle) > 0.15) {
      steerTarget += driftAngle * 0.5 * maxSteer
      escThrottleCut = clamp(1 - (Math.abs(driftAngle) - 0.15) * 2, 0.35, 1)
    }
    const steerRate = spec.steering.responseRate * (1 - this.damage * 0.3)
    const steerAngle = input.directSteering ? steerTarget : damp(this.lastSteerAngle, steerTarget, steerRate, dt)
    this.lastSteerAngle = steerAngle

    // --- Gearbox / engine ---------------------------------------------------
    const g = spec.gearbox
    const eng = spec.engine
    const isEv = eng.type === 'ev'
    let throttle = clamp01(input.throttle) * escThrottleCut
    let brake = clamp01(input.brake)

    // Reverse handling: holding the brake for a moment at standstill engages reverse;
    // any throttle (or rolling forward) re-engages first gear immediately.
    if (this.gear === -1 && this.assists.autoTransmission) {
      if (throttle > 0.2 || forwardSpeed > 1.5) {
        this.gear = 1
        this.reverseDwell = 0
        // This step: treat the throttle press as braking so the car settles before driving off.
        brake = Math.max(brake, throttle)
        throttle = 0
      } else {
        const tmp = throttle
        throttle = brake
        brake = tmp
      }
    } else if (this.assists.autoTransmission && Math.abs(forwardSpeed) < 0.8 && brake > 0.4 && throttle < 0.05 && !input.handbrake) {
      this.reverseDwell += dt
      if (this.reverseDwell > 0.35) {
        this.gear = -1
        this.reverseDwell = 0
        brake = 0
      }
    } else this.reverseDwell = 0

    // Automatic pit-lane speed limiter: holds the car at the limit by cutting
    // throttle, braking gently when it enters too hot.
    if (this.speedLimitKmh !== null && this.gear > 0) {
      const over = forwardSpeed * 3.6 - this.speedLimitKmh
      if (over > 0) {
        throttle = 0
        if (over > 4) brake = Math.max(brake, 0.35)
      } else if (over > -6) throttle = Math.min(throttle, clamp01(-over / 6))
    }

    const ratio = this.gear > 0 ? g.ratios[this.gear - 1] : this.gear < 0 ? -g.reverseRatio : 0
    const driveWheels = this.wheels.filter((w) => w.isDriven)
    let avgOmega = 0
    for (const w of driveWheels) avgOmega += w.angularVelocity
    avgOmega /= Math.max(1, driveWheels.length)
    const wheelRpm = Math.abs(avgOmega * ratio * g.finalDrive) * (60 / (2 * Math.PI))

    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt
      this.rpm = damp(this.rpm, wheelRpm, 12, dt)
    } else {
      const targetRpm = isEv ? wheelRpm : Math.max(eng.idleRpm, wheelRpm)
      // Clutch slip at launch keeps revs up under throttle.
      const launchRpm = throttle > 0.1 && Math.abs(forwardSpeed) < 6 && !isEv ? eng.idleRpm + throttle * (eng.peakRpm * 0.55 - eng.idleRpm) : 0
      this.rpm = damp(this.rpm, Math.max(targetRpm, launchRpm), 20, dt)
    }
    this.rpm = clamp(this.rpm, 0, eng.redline * 1.03)

    // Automatic shifting — decided on road speed so spinning or airborne wheels never
    // drag the box into a tall gear.
    if (this.assists.autoTransmission && this.gear > 0 && this.shiftTimer <= 0) {
      const roadRpm = (Math.abs(forwardSpeed) / spec.body.wheelRadius) * Math.abs(ratio) * g.finalDrive * (60 / (2 * Math.PI))
      if (roadRpm > eng.redline * 0.93 && this.gear < g.ratios.length && throttle > 0.05) this.shiftUp()
      else if ((roadRpm < eng.redline * 0.38 && this.gear > 1) || (Math.abs(forwardSpeed) < 3 && this.gear > 1)) this.shiftDown()
    }

    // Rev limiter.
    let limiter = false
    if (this.rpm >= eng.redline) {
      this.limiterFlicker += dt
      limiter = this.limiterFlicker % 0.08 < 0.04
    } else this.limiterFlicker = 0

    // Torque curve.
    const rpmT = this.rpm / eng.peakRpm
    let curve: number
    if (isEv) curve = rpmT < 1 ? 1 : 1 / rpmT
    else {
      curve = rpmT < 1 ? 1 - 0.6 * (1 - rpmT) * (1 - rpmT) : Math.max(0.3, 1 - 1.3 * (rpmT - 1) * (rpmT - 1))
      if (eng.type === 'hybrid') curve = curve * 0.8 + 0.25
    }

    // Turbo / supercharger.
    let inductionMult = 1
    if (eng.turbo && !isEv) {
      const spoolTarget = throttle * clamp((this.rpm - eng.idleRpm) / (eng.peakRpm * 0.75 - eng.idleRpm), 0, 1)
      if (throttle < 0.2 && this.lastThrottle >= 0.5 && this.turboBoost > 0.4) {
        this.onTurboBlowoff?.(this.turboBoost)
        this.turboBoost *= 0.35
      }
      this.turboBoost = damp(this.turboBoost, spoolTarget, throttle > 0.2 ? eng.turboSpool : eng.turboSpool * 3, dt)
      inductionMult = 1 + this.turboBoost * eng.turboGain
    } else if (eng.supercharged) {
      this.turboBoost = clamp(this.rpm / eng.redline, 0, 1)
      inductionMult = 1 + this.turboBoost * eng.turboGain
    }
    this.lastThrottle = throttle

    // ERS battery. Deploys on the boost button under throttle; harvests
    // kinetic energy under braking and lift-off coasting instead of the old
    // unconditional trickle. Deploy power tapers off below ~30% charge so a
    // draining battery fades instead of cutting out.
    const ersCharge = this.nitro / Math.max(1, spec.performance.nitroCapacity)
    const nitroActive = input.boost && this.nitro > 0 && throttle > 0.1 && this.gear > 0
    let ersHarvest = false
    if (nitroActive) {
      this.nitro = Math.max(0, this.nitro - 22 * dt)
      inductionMult *= 1 + spec.performance.nitroPower * (0.35 + 0.65 * clamp01(ersCharge / 0.3))
    } else if (forwardSpeed > 4 && this.gear > 0 && this.nitro < spec.performance.nitroCapacity) {
      const rate = brake > 0.15 ? 14 * brake : throttle < 0.08 ? 5 : 0
      if (rate > 0) {
        this.nitro = Math.min(spec.performance.nitroCapacity, this.nitro + rate * dt)
        ersHarvest = true
      }
    }

    // Fuel.
    if (this.fuelEnabled) {
      const burn = (0.08 + throttle * 0.9) * (this.rpm / eng.redline) * spec.performance.fuelConsumption * dt * 0.06
      this.fuel = Math.max(0, this.fuel - burn)
    }
    const fuelFactor = this.fuel > 0 ? 1 : 0
    const powerFactor = (1 - this.damage * 0.45) * this.powerScale

    let engineTorque = eng.maxTorque * curve * throttle * inductionMult * powerFactor * fuelFactor
    if (limiter || this.shiftTimer > 0) engineTorque = 0
    // Engine braking.
    if (throttle < 0.05 && this.gear > 0 && !isEv) engineTorque = -eng.maxTorque * 0.08 * (this.rpm / eng.redline)
    if (isEv && throttle < 0.05) engineTorque = -eng.maxTorque * 0.05 * clamp(Math.abs(forwardSpeed) / 10, 0, 1) // regen

    const totalWheelTorque = engineTorque * ratio * g.finalDrive * 0.9
    for (const w of this.wheels) {
      if (!w.isDriven) {
        this.wheelTorque[w.index] = 0
        continue
      }
      let share: number
      if (g.drivetrain === 'AWD') share = (w.isFront ? 1 - g.rearBias : g.rearBias) * 0.5
      else share = 0.5
      this.wheelTorque[w.index] = totalWheelTorque * share
    }

    // --- Wheels: raycast, suspension ---------------------------------------
    const R = this.physics.RAPIER
    let wheelsOnGround = 0
    let looseCount = 0
    const rayDir = _rayDir.copy(_up).multiplyScalar(-1)
    for (const w of this.wheels) {
      const origin = _origin.copy(w.attachLocal).applyQuaternion(_q).add(_pos)
      const ray = new R.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: rayDir.x, y: rayDir.y, z: rayDir.z })
      const hit = this.physics.world.castRayAndGetNormal(ray, this.rayLength + 0.02, true, undefined, FILTER_GROUPS, undefined, this.body)
      w.prevCompression = w.compression
      const hadContact = w.contact
      // A wall/underside is never a suspension support. Replacing its normal
      // with chassis-up converted grazing contacts into a launching spring.
      if (hit && hit.timeOfImpact <= this.rayLength && hit.normal.y > 0.15 &&
        hit.normal.x * _up.x + hit.normal.y * _up.y + hit.normal.z * _up.z > 0.25) {
        w.contact = true
        wheelsOnGround++
        const toi = hit.timeOfImpact
        w.compression = this.rayLength - toi
        w.contactPoint.copy(origin).addScaledVector(rayDir, toi)
        w.contactNormal.set(hit.normal.x, hit.normal.y, hit.normal.z)
        w.hubWorld.copy(origin).addScaledVector(rayDir, toi - w.radius)
        const meta = this.physics.getMeta(hit.collider.handle)
        w.surface = meta?.surface ?? 'asphalt'
        if (SURFACES[w.surface].loose) looseCount++
        if (!hadContact) {
          // Touchdown: the tyre grips the road immediately, so match wheel speed to ground speed.
          const rel = _vel.copy(w.contactPoint).sub(_pos)
          const vel = rel.cross(_angvel).multiplyScalar(-1).add(_linvel)
          w.angularVelocity = vel.dot(_fwd) / w.radius
        }
      } else {
        w.contact = false
        w.compression = damp(w.compression, 0, 6, dt)
        w.hubWorld.copy(origin).addScaledVector(rayDir, this.rayLength - w.radius - w.compression)
        w.load = 0
        w.suspensionForce = 0
        w.skid = 0
        w.saturation = 0
        w.longForce = w.latForce = 0
        w.slipRatio = w.slipAngle = 0
        w.locked = false
        w.spinning = false
        // Free spin in the air: drive torque spins the wheel up to the redline-equivalent speed;
        // engine braking only slows it (it can never reverse a wheel).
        const airTorque = this.wheelTorque[w.index]
        if (airTorque >= 0) w.angularVelocity += (airTorque / WHEEL_INERTIA) * dt
        else w.angularVelocity = damp(w.angularVelocity, 0, 3, dt)
        w.angularVelocity *= 0.995
        const maxOmega = ((eng.redline / 60) * 2 * Math.PI) / Math.max(0.5, Math.abs(ratio) * g.finalDrive)
        if (Math.abs(w.angularVelocity) > maxOmega) w.angularVelocity = sign(w.angularVelocity) * maxOmega
      }
    }

    // Suspension forces.
    const sus = spec.suspension
    for (const w of this.wheels) {
      if (!w.contact) continue
      const compVel = (w.compression - w.prevCompression) / dt
      const damping = compVel > 0 ? sus.dampingCompression : sus.dampingRebound
      let force = sus.stiffness * w.compression + damping * compVel
      if (w.compression > sus.travel) force += (w.compression - sus.travel) * sus.stiffness * 10
      // Surface roughness feeds small random bumps into the spring.
      const rough = SURFACES[w.surface].roughness
      if (rough > 0 && speed > 2) force += (Math.random() - 0.5) * rough * spec.mass * 2.5 * Math.min(1, speed / 15)
      w.suspensionForce = Math.max(0, force)
    }
    // Anti-roll bars.
    for (const axle of [0, 2]) {
      const l = this.wheels[axle]
      const r = this.wheels[axle + 1]
      if (l.contact && r.contact) {
        const transfer = (l.compression - r.compression) * sus.antiRoll
        l.suspensionForce = Math.max(0, l.suspensionForce + transfer)
        r.suspensionForce = Math.max(0, r.suspensionForce - transfer)
      }
    }
    for (const w of this.wheels) {
      if (!w.contact) continue
      w.load = w.suspensionForce
      const origin = _origin.copy(w.attachLocal).applyQuaternion(_q).add(_pos)
      _v3.copy(w.contactNormal).multiplyScalar(w.suspensionForce)
      body.addForceAtPoint({ x: _v3.x, y: _v3.y, z: _v3.z }, { x: origin.x, y: origin.y, z: origin.z }, true)
    }

    // --- Tyre forces ---------------------------------------------------------
    const tires = spec.tires
    const brk = spec.brakes
    const tyreMods = this.mods
    const wetness = this.weather.wetness
    for (const w of this.wheels) {
      if (!w.contact) continue
      const n = w.contactNormal
      // Steered forward direction projected onto the contact plane.
      const steer = w.isFront ? steerAngle * (w.isLeft === steerAngle > 0 ? 1.12 : 0.92) : 0
      w.steerAngle = steer
      _steerQ.setFromAxisAngle(_up, steer)
      const fwd = _v2.copy(_fwd).applyQuaternion(_steerQ)
      fwd.addScaledVector(n, -fwd.dot(n)).normalize()
      const right = _v3.crossVectors(n, fwd).normalize()

      // Contact patch velocity.
      const rel = _vel.copy(w.contactPoint).sub(_pos)
      const vel = rel.cross(_angvel).multiplyScalar(-1).add(_linvel) // v = linvel + angvel × r
      const vLong = vel.dot(fwd)
      const vLat = vel.dot(right)
      w.velocityLong = vLong
      w.velocityLat = vLat

      const baseGrip = w.isFront ? tires.gripFront : tires.gripRear
      const grip = effectiveGrip(w.surface, this.weather, tyreMods) * baseGrip * this.gripScale
      const maxF = grip * w.load
      const peakSr = tires.peakSlipRatio
      const falloff = clamp(tires.falloff, 0.4, 0.98)

      // Longitudinal: implicit wheel integrator.
      let driveT = this.wheelTorque[w.index]
      const denom = Math.max(Math.abs(vLong), 3)
      const K = maxF / peakSr
      // Traction control: cut torque when the driven wheel spins past the peak.
      if (this.assists.tcs && driveT > 0) {
        const sr0 = (w.angularVelocity * w.radius - vLong) / denom
        if (sr0 > peakSr * 1.4) driveT *= 0.25
      }
      let omega = w.angularVelocity
      const a = (K * w.radius * w.radius * dt) / (WHEEL_INERTIA * denom)
      omega = (omega + ((driveT + (K * w.radius * vLong) / denom) * dt) / WHEEL_INERTIA) / (1 + a)
      // Brakes: friction torque opposing rotation, cannot flip the wheel's sign.
      let brakeT = brake * brk.maxTorque * (w.isFront ? brk.frontBias : 1 - brk.frontBias) * 2
      if (input.handbrake && !w.isFront) brakeT += brk.handbrakeTorque
      brakeT *= 1 - this.damage * 0.25
      let locked = false
      if (brakeT > 0) {
        const dOmega = (brakeT / WHEEL_INERTIA) * dt
        if (Math.abs(omega) <= dOmega) {
          omega = 0
          locked = Math.abs(vLong) > 1.5
        } else omega -= sign(omega) * dOmega
        // ABS keeps the wheel at peak slip instead of locking.
        if (locked && this.assists.abs && !(input.handbrake && !w.isFront)) {
          omega = (vLong / w.radius) * (1 - peakSr * 1.1)
          locked = false
        }
      }
      let sr = (omega * w.radius - vLong) / denom
      let longForce = maxF * tireCurve(sr, peakSr, falloff) * sign(sr)
      // Past the peak (spinning / locked), use explicit update with the real (lower) force so wheelspin runs away naturally.
      if (Math.abs(sr) > peakSr) {
        const omegaExplicit = w.angularVelocity + ((driveT - longForce * w.radius) / WHEEL_INERTIA) * dt
        // Only allow explicit runaway when it moves further from the road speed (spin/lock), never toward instability.
        if (Math.abs(omegaExplicit * w.radius - vLong) > Math.abs(omega * w.radius - vLong)) {
          omega = brakeT > 0 && locked ? 0 : omegaExplicit
          sr = (omega * w.radius - vLong) / denom
          longForce = maxF * tireCurve(sr, peakSr, falloff) * sign(sr)
        }
      }
      if (Math.abs(omega) > 400) omega = sign(omega) * 400
      w.angularVelocity = omega
      w.slipRatio = sr
      w.locked = locked
      w.spinning = w.isDriven && driveT > 0 && sr > peakSr * 2 && Math.abs(vLong) < 40

      // Lateral: slip angle through the same curve, limited so it never overshoots at crawling speed.
      const slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), 1.0))
      const peakSa = tires.peakSlipAngle * (1 + wetness * 0.2)
      let latForce = -maxF * tireCurve(slipAngle, peakSa, falloff * (w.isFront ? 1 : 1 - (1 - falloff) * 0.15)) * sign(vLat)
      const massShare = w.load / 9.81
      const maxLat = (massShare * Math.abs(vLat)) / dt
      if (Math.abs(latForce) > maxLat) latForce = sign(latForce) * maxLat
      w.slipAngle = slipAngle

      const combined = frictionEllipse(longForce, latForce, maxF, sr / peakSr)
      w.longForce = combined.long
      w.latForce = combined.lat
      w.saturation = combined.saturation

      // Rolling resistance + off-surface drag.
      const sp = SURFACES[w.surface]
      let rolling = 0
      if (Math.abs(vLong) > 0.2) rolling = -sign(vLong) * tires.rollingResistance * sp.rollingResistance * w.load
      const surfaceDrag = sp.dragFactor * w.load
      const force = _force.copy(fwd).multiplyScalar(w.longForce + rolling).addScaledVector(right, w.latForce)
      if (surfaceDrag > 0 && speed > 0.5) force.addScaledVector(_v.copy(vel).normalize(), -surfaceDrag)
      body.addForceAtPoint({ x: force.x, y: force.y, z: force.z }, { x: w.contactPoint.x, y: w.contactPoint.y, z: w.contactPoint.z }, true)

      // Skid intensity for effects/audio.
      const lateralSlip = Math.abs(slipAngle) / peakSa
      const longSlip = Math.abs(sr) / peakSr
      const slipMag = Math.max(lateralSlip, longSlip)
      const target = slipMag > 1.1 ? clamp01((slipMag - 1.1) * 0.5) * clamp01(speed / 6) : 0
      w.skid = damp(w.skid, target, 12, dt)
      w.rotation += w.angularVelocity * dt
    }

    // --- Aero ----------------------------------------------------------------
    const aero = spec.aero
    if (speed > 0.1) {
      // DRS: open rear wing sheds drag and rear downforce and buys a little
      // extra top speed on the straights.
      const drsDrag = this.drsActive ? 0.62 : 1
      const dragMag = 0.5 * RHO_AIR * aero.dragCoefficient * aero.frontalArea * speed * speed * drsDrag
      const drag = _v.copy(_linvel).multiplyScalar(-dragMag / speed)
      // Soft top-speed limiter matches the design figure regardless of gearing.
      const vmax = (spec.performance.topSpeed / 3.6) * (this.drsActive ? 1.06 : 1)
      if (forwardSpeed > vmax) drag.addScaledVector(_fwd, -spec.mass * (forwardSpeed - vmax) * 1.5)
      if (forwardSpeed < -9) drag.addScaledVector(_fwd, -spec.mass * (forwardSpeed + 9) * 2)
      body.addForce({ x: drag.x, y: drag.y, z: drag.z }, true)

      const vLongSq = forwardSpeed * forwardSpeed
      const dfF = aero.downforceFront * vLongSq
      const dfR = aero.downforceRear * vLongSq * (this.drsActive ? 0.5 : 1)
      const fPt = _v2.set(0, 0, this.frontAxleZ).applyQuaternion(_q).add(_pos)
      const rPt = _v3.set(0, 0, this.rearAxleZ).applyQuaternion(_q).add(_pos)
      const down = _v.copy(_up).multiplyScalar(-1)
      body.addForceAtPoint({ x: down.x * dfF, y: down.y * dfF, z: down.z * dfF }, { x: fPt.x, y: fPt.y, z: fPt.z }, true)
      body.addForceAtPoint({ x: down.x * dfR, y: down.y * dfR, z: down.z * dfR }, { x: rPt.x, y: rPt.y, z: rPt.z }, true)
    }

    // --- Airborne / rollover handling --------------------------------------
    const airborne = wheelsOnGround === 0
    if (airborne) {
      this.airborneTime += dt
      // Gentle angular damping in the air so jumps land flat-ish.
      body.addTorque({ x: -_angvel.x * spec.mass * 0.6, y: -_angvel.y * spec.mass * 0.2, z: -_angvel.z * spec.mass * 0.6 }, true)
    } else this.airborneTime = 0
    if (_up.y < 0.15) {
      this.upsideDownTime += dt
      if (this.upsideDownTime > 2.5) this.needsRespawn = true
    } else this.upsideDownTime = 0
    // Beached: resting on a wall/kerb with the driven wheels in the air.
    if (wheelsOnGround <= 1 && speed < 2.5) {
      this.beachedTime += dt
      if (this.beachedTime > 3) this.needsRespawn = true
    } else this.beachedTime = 0
    if (this.position.y < -60) this.needsRespawn = true

    // --- Telemetry -----------------------------------------------------------
    const accel = _v.copy(_linvel).sub(this.prevVelocity).divideScalar(dt)
    this.prevVelocity.copy(_linvel)
    t.speed = Math.abs(forwardSpeed) > speed * 0.9 ? forwardSpeed : speed * sign(forwardSpeed || 1)
    t.speedKmh = Math.abs(forwardSpeed) * 3.6
    t.rpm = this.rpm
    t.gear = this.gear
    t.throttle = throttle
    t.brake = brake
    t.turboBoost = this.turboBoost
    t.nitro = this.nitro
    t.nitroActive = nitroActive
    t.harvesting = ersHarvest
    t.fuel = this.fuel
    t.damage = this.damage
    t.engineTorque = engineTorque
    t.airborne = airborne
    t.driftAngle = driftAngle
    let rearSat = 0
    for (const w of this.wheels) if (!w.isFront) rearSat = Math.max(rearSat, w.saturation)
    t.drifting = speed > 7 && Math.abs(driftAngle) > 0.2 && rearSat > 0.85
    t.gLat = accel.dot(_right) / 9.81
    t.gLong = accel.dot(_fwd) / 9.81
    t.steerAngle = steerAngle
    t.wheelsOnGround = wheelsOnGround
    t.powerFactor = powerFactor
    t.limiter = limiter
    t.shifting = this.shiftTimer > 0
    t.onLooseSurface = looseCount >= 2
    t.wet = wetness
  }

  dispose(): void {
    this.physics.removeBody(this.body)
  }
}
