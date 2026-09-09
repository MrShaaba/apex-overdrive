/**
 * Rival driver brain.
 *
 * Every frame the driver:
 *  - tracks its progress along the spline and looks ahead on the racing line
 *  - steers with pure-pursuit toward a look-ahead point (distance grows with speed)
 *  - modulates throttle/brake against the speed profile, scaled by skill,
 *    weather, tyre grip and damage
 *  - senses nearby cars: picks an overtaking side when it is faster, defends its
 *    line when a car behind is closing, and backs off to avoid rear-ending
 *  - injects personality-driven mistakes (late braking, wide exits, snap
 *    corrections) with a frequency set by `consistency`
 *  - applies catch-up balancing relative to the player via grip/power scaling
 *  - recovers when stuck or facing the wrong way
 *
 * The result is a `VehicleInput` fed into the same physics controller as the
 * player, so AI cars obey identical rules.
 */

import * as THREE from 'three'
import { steeringLimit, type VehicleController, type VehicleInput } from '../physics/VehicleController'
import type { RacingLine } from './RacingLine'
import type { DriverProfile } from './DriverProfiles'
import { clamp, damp, lerp } from '../core/MathUtils'

export interface AITrafficEntry {
  id: number
  position: THREE.Vector3
  velocity: THREE.Vector3
  progress: number
  lateral: number
  isPlayer: boolean
  finished: boolean
}

export interface AIContext {
  traffic: AITrafficEntry[]
  playerProgress: number
  trackLength: number
  raceActive: boolean
  /** 0 = dry, 1 = soaked. */
  wetness: number
  snow: number
  /** Global skill scale from the difficulty setting (0.7 rookie … 1.1 legend). */
  difficultyScale: number
  /** How strongly to rubber-band (0 = off, 1 = full). */
  catchUp: number
  closed: boolean
  /** Seconds since the race went green. */
  raceTime: number
}

const _target = new THREE.Vector3()
const _toTarget = new THREE.Vector3()
const _flat = new THREE.Vector3()

export class AIDriver {
  readonly input: VehicleInput = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false }
  private progressIndex = 0
  progress = 0
  lateral = 0
  private lateralBias = 0
  private lateralBiasTarget = 0
  private overtakeSide = 0
  private overtakeTimer = 0
  private errorTimer = 0
  private errorSteer = 0
  private errorBrakeDelay = 0
  private stuckTimer = 0
  private stuckProgress = 0
  private stuckSampleTimer = 0
  private reverseSteer = 0
  private recovery: 'none' | 'reverse' | 'rejoin' = 'none'
  private recoveryTimer = 0
  private recoveryAttempts = 0
  private recoveryStartProgress = 0
  private wrongWayTimer = 0
  private boostCooldown = 4
  private rng: () => number
  gripFactor: number
  /** Public for UI/debug: current intent. */
  intent: 'racing' | 'overtaking' | 'defending' | 'recovering' | 'mistake' = 'racing'

  constructor(
    readonly vehicle: VehicleController,
    readonly line: RacingLine,
    readonly profile: DriverProfile,
    startIndex: number,
  ) {
    this.progressIndex = startIndex
    this.rng = () => Math.random()
    const s = vehicle.spec
    this.gripFactor = ((s.tires.gripFront + s.tires.gripRear) / 2) * (1 + (s.aero.downforceFront + s.aero.downforceRear) / s.mass * 12)
    this.progress = line.spline.samples[startIndex]?.distance ?? 0
  }

  update(dt: number, ctx: AIContext): VehicleInput {
    const v = this.vehicle
    const spline = this.line.spline
    const pos = v.position
    const p = spline.progressAt(pos, this.progressIndex)
    this.progressIndex = p.index
    this.progress = p.distance
    this.lateral = p.lateral
    const speed = v.telemetry.speed
    const absSpeed = Math.abs(speed)
    const input = this.input

    if (!ctx.raceActive) {
      input.throttle = 0
      input.brake = 0
      input.handbrake = true
      input.steer = 0
      input.boost = false
      return input
    }

    // --- Recovery state machine ----------------------------------------------
    // none → (stuck or wrong way) → reverse (swing nose toward the line) → rejoin (drive
    // slowly back onto the line, stuck detection suspended) → none. Repeated failures respawn.
    const tangent = spline.samples[this.progressIndex].tangent
    const fwdDot = v.forward.dot(tangent)
    const toLineNow = this.line.targetAt(this.progressIndex + 6, 0, _target).sub(pos)
    toLineNow.y = 0
    const headingToLine = toLineNow.lengthSq() > 1e-3 ? toLineNow.normalize().dot(v.forward) : 1
    if (this.recovery === 'reverse') {
      this.recoveryTimer -= dt
      this.intent = 'recovering'
      input.throttle = 0
      input.brake = 0.4 // In reverse gear brake acts as reverse throttle.
      input.steer = this.reverseSteer
      input.handbrake = false
      input.boost = false
      if (this.recoveryTimer <= 0 || headingToLine > 0.6) {
        this.recovery = 'rejoin'
        this.recoveryTimer = 4
      }
      return input
    }
    if (this.recovery === 'rejoin') {
      this.recoveryTimer -= dt
      if (this.recoveryTimer <= 0) {
        this.recovery = 'none'
        this.stuckProgress = this.progress
        this.stuckSampleTimer = 0
        this.stuckTimer = 0
      }
    } else {
      // Progress-based stuck detection: circling at walking pace counts as stuck too.
      this.stuckSampleTimer += dt
      if (this.stuckSampleTimer > 2.5) {
        let advanced = this.progress - this.stuckProgress
        if (ctx.closed) {
          if (advanced < -ctx.trackLength / 2) advanced += ctx.trackLength
          if (advanced > ctx.trackLength / 2) advanced -= ctx.trackLength
        }
        if (advanced < 5 && ctx.raceTime > 3) this.stuckTimer += 2.5
        else this.stuckTimer = 0
        this.stuckProgress = this.progress
        this.stuckSampleTimer = 0
      }
    }
    if (fwdDot < -0.2 && absSpeed < 8) this.wrongWayTimer += dt
    else this.wrongWayTimer = 0
    if (this.recovery === 'none' && (this.stuckTimer >= 2.5 || this.wrongWayTimer > 3)) {
      this.stuckTimer = 0
      this.wrongWayTimer = 0
      let sinceLast = this.progress - this.recoveryStartProgress
      if (ctx.closed && sinceLast < -ctx.trackLength / 2) sinceLast += ctx.trackLength
      this.recoveryAttempts = Math.abs(sinceLast) > 60 ? 1 : this.recoveryAttempts + 1
      this.recoveryStartProgress = this.progress
      if (this.recoveryAttempts > 3) {
        // Hopelessly stuck — put the car back on the centreline.
        v.needsRespawn = true
        this.recoveryAttempts = 0
        this.recovery = 'rejoin'
        this.recoveryTimer = 3
      } else {
        this.recovery = 'reverse'
        this.recoveryTimer = headingToLine > 0.3 ? 0.8 : 1.6
        // Reversing with the wheels turned right swings the nose LEFT, so steer away from the
        // side the line is on to bring the nose around toward it.
        const side = toLineNow.x * v.forward.z - toLineNow.z * v.forward.x
        this.reverseSteer = side > 0 ? -0.9 : 0.9
      }
    }
    const rejoining = this.recovery === 'rejoin'
    if (rejoining) this.intent = 'recovering'

    // --- Skill-derived parameters ---------------------------------------------
    const skill = clamp(this.profile.skill * ctx.difficultyScale, 0.3, 1.15)
    const weatherPenalty = 1 - ctx.wetness * 0.22 - ctx.snow * 0.4
    const damagePenalty = 1 - v.getDamage() * 0.25
    const paceScale = lerp(0.72, 1.0, skill) * weatherPenalty * damagePenalty
    const gripScaleForSpeed = Math.sqrt(this.gripFactor) * v.gripScale

    // --- Catch-up / rubber-band ------------------------------------------------
    const half = ctx.trackLength / 2
    let gap = this.progress - ctx.playerProgress
    if (ctx.closed) {
      if (gap > half) gap -= ctx.trackLength
      if (gap < -half) gap += ctx.trackLength
    }
    // Positive gap = ahead of the player. Ahead → slightly slower; behind → slightly faster.
    const band = clamp(-gap / 250, -1, 1) * ctx.catchUp
    v.powerScale = damp(v.powerScale, 1 + band * 0.14, 1.5, dt)
    v.gripScale = damp(v.gripScale, 1 + band * 0.06 + (skill - 0.7) * 0.08, 1.5, dt)

    // --- Traffic sensing ----------------------------------------------------------
    let carAhead: AITrafficEntry | null = null
    let aheadGap = Infinity
    let carBehind: AITrafficEntry | null = null
    let behindGap = Infinity
    for (const t of ctx.traffic) {
      if (t.id === v.id || t.finished) continue
      let d = t.progress - this.progress
      if (ctx.closed) {
        if (d > half) d -= ctx.trackLength
        if (d < -half) d += ctx.trackLength
      }
      if (d > 0 && d < aheadGap && d < 45 && Math.abs(t.lateral - this.lateral) < 5) {
        aheadGap = d
        carAhead = t
      } else if (d < 0 && -d < behindGap && -d < 25 && Math.abs(t.lateral - this.lateral) < 5) {
        behindGap = -d
        carBehind = t
      }
    }

    // --- Lateral intent: overtaking / defending --------------------------------
    if (!rejoining) this.intent = 'racing'
    const aggression = this.profile.aggression
    let targetBias = 0
    let followSpeedCap = Infinity
    // Start discipline: hold position for the first seconds so the grid clears cleanly.
    const startPhase = ctx.raceTime < 4 + (1 - aggression) * 3 || rejoining
    if (carAhead && !startPhase) {
      const closing = absSpeed - carAhead.velocity.length()
      const wantsToPass = closing > -1 && aheadGap < 18 + aggression * 14
      if (wantsToPass && this.overtakeTimer <= 0) {
        // Choose the side with more room relative to the car ahead and the track edge.
        const lineOffset = this.line.offsets[this.progressIndex]
        const roomLeft = this.line.limit + carAhead.lateral
        const roomRight = this.line.limit - carAhead.lateral
        const prefer = roomLeft > roomRight ? -1 : 1
        this.overtakeSide = Math.abs(roomLeft - roomRight) < 1 ? (lineOffset > 0 ? -1 : 1) : prefer
        this.overtakeTimer = 2.5 + aggression * 2
      }
      if (this.overtakeTimer > 0) {
        this.intent = 'overtaking'
        targetBias = this.overtakeSide * (2.4 + aggression * 0.8) - this.line.offsets[this.progressIndex] * 0.5
        // Do not drive into the car in front: cap speed unless alongside.
        const alongside = Math.abs(carAhead.lateral - this.lateral) > 2.2
        if (!alongside && aheadGap < 6 + absSpeed * 0.12) followSpeedCap = carAhead.velocity.length() * (aggression > 0.7 ? 1.02 : 0.97)
      } else if (aheadGap < 8 + absSpeed * 0.18) {
        followSpeedCap = carAhead.velocity.length() * 0.98
      }
    }
    if (this.overtakeTimer > 0) this.overtakeTimer -= dt
    if (carBehind && !carAhead && !startPhase && this.profile.defending > 0.3 && behindGap < 14) {
      const closing = carBehind.velocity.length() - absSpeed
      if (closing > -2 && this.rng() < this.profile.defending) {
        this.intent = 'defending'
        // Mirror the attacker's lateral position to block.
        targetBias = clamp(carBehind.lateral - this.line.offsets[this.progressIndex], -2.5, 2.5)
      }
    }
    this.lateralBiasTarget = targetBias
    this.lateralBias = damp(this.lateralBias, this.lateralBiasTarget, 2.2 + aggression, dt)

    // --- Mistakes ------------------------------------------------------------------
    this.errorTimer -= dt
    if (this.errorTimer <= 0) {
      const period = lerp(4, 40, this.profile.consistency)
      this.errorTimer = period * (0.5 + this.rng())
      const roll = this.rng()
      if (roll < 0.4) this.errorSteer = (this.rng() - 0.5) * (1 - this.profile.consistency) * 0.8
      else if (roll < 0.75) this.errorBrakeDelay = 0.6 + (1 - this.profile.consistency) * 1.2
      else this.errorSteer = 0
      setTimeout(() => (this.errorSteer = 0), 500 + this.rng() * 600)
    }
    if (this.errorBrakeDelay > 0) {
      this.errorBrakeDelay -= dt
      this.intent = 'mistake'
    }

    // --- Steering: pure pursuit ------------------------------------------------------
    const lookAhead = 9 + absSpeed * lerp(0.42, 0.3, skill)
    const lookIndex = this.progressIndex + Math.round(lookAhead / 2)
    this.line.targetAt(lookIndex, startPhase ? 0 : this.lateralBias, _target)
    _toTarget.copy(_target).sub(pos)
    _toTarget.y = 0
    _flat.copy(v.forward)
    _flat.y = 0
    _flat.normalize()
    const angle = Math.atan2(_toTarget.x * _flat.z - _toTarget.z * _flat.x, _toTarget.dot(_flat))
    // Pure pursuit: curvature needed to reach the target, capped by achievable lateral acceleration.
    const dist = Math.max(3, _toTarget.length())
    let curvature = (2 * Math.sin(angle)) / dist
    const aLatMax = 9.81 * this.gripFactor * lerp(0.55, 0.82, skill) * weatherPenalty * v.gripScale
    const kMax = aLatMax / Math.max(25, absSpeed * absSpeed)
    curvature = clamp(curvature, -kMax, kMax)
    const wantedLock = Math.atan(v.spec.body.wheelbase * curvature)
    const drift = v.telemetry.driftAngle
    const available = steeringLimit(v.spec, absSpeed, drift)
    let steer = clamp(wantedLock / available, -1, 1)
    // Big heading errors at low speed (after a spin): turn hard toward the line.
    if (absSpeed < 6 && Math.abs(angle) > 0.6) steer = clamp(angle * 2, -1, 1)
    // Crawling at full lock just scrubs the fronts; cap lock until the car is rolling.
    if (absSpeed < 4) steer = clamp(steer, -0.6, 0.6)
    // Counter-steer when sliding: driftAngle > 0 means the nose points left of the velocity
    // vector, so steer right (positive) toward the direction of travel.
    if (Math.abs(drift) > 0.15 && absSpeed > 8) steer += clamp((drift * lerp(0.5, 0.9, skill) * 0.5) / Math.max(0.1, available), -0.6, 0.6)
    steer += this.errorSteer
    input.steer = damp(input.steer, clamp(steer, -1, 1), 14, dt)

    // --- Speed control -------------------------------------------------------------------
    const aheadIndex = this.progressIndex + Math.round((10 + absSpeed * 0.9) / 2)
    let targetSpeed = Infinity
    // Scan as far as the car needs to stop from this speed (plus a margin): a fixed
    // multiple of speed left a 200 km/h run into a slow corner with no room to brake.
    const lookSamples = Math.round(((absSpeed * absSpeed) / 11 + 30) / 2)
    for (let k = 0; k <= lookSamples; k += 2) {
      const idx = spline.wrapIndex(this.progressIndex + k)
      const dist = k * 2
      // Braking-distance aware: allow higher speed for far corners.
      const refV = this.line.referenceSpeed[idx] * gripScaleForSpeed * paceScale
      const brakeAccel = 8.5 * skill * v.gripScale * weatherPenalty
      const allowed = Math.sqrt(refV * refV + 2 * brakeAccel * dist)
      targetSpeed = Math.min(targetSpeed, allowed)
    }
    void aheadIndex
    targetSpeed = Math.min(targetSpeed, (v.spec.performance.topSpeed / 3.6) * lerp(0.9, 1.0, skill))
    if (this.errorBrakeDelay > 0) targetSpeed *= 1.12
    targetSpeed = Math.min(targetSpeed, followSpeedCap)
    // Off the racing surface or rejoining after a spin: slow down rather than powering across the run-off.
    if (v.telemetry.onLooseSurface) targetSpeed = Math.min(targetSpeed, 14)
    if (rejoining) targetSpeed = Math.min(targetSpeed, 11)

    const err = targetSpeed - absSpeed
    if (err > 0.5) {
      input.throttle = damp(input.throttle, clamp(err / 6, 0.35, 1), 8, dt)
      input.brake = damp(input.brake, 0, 12, dt)
    } else {
      input.throttle = damp(input.throttle, 0, 12, dt)
      input.brake = damp(input.brake, clamp(-err / 8, 0.15, 1), 10, dt)
    }
    // Traction modulation for spinning wheels on low-grip surfaces.
    if (v.telemetry.onLooseSurface || ctx.wetness > 0.5) input.throttle = Math.min(input.throttle, 0.75)
    // Handbrake for very tight hairpins with a drift-oriented car.
    input.handbrake = v.spec.vehicleClass === 'drift' && Math.abs(angle) > 0.9 && absSpeed > 12 && absSpeed < 26

    // Nitro: use on straights when behind, or when aggressive and clear ahead.
    this.boostCooldown -= dt
    const straight = this.line.curvature[this.progressIndex] < 0.004
    const wantBoost = straight && input.throttle > 0.9 && (gap < -20 || (aggression > 0.6 && !carAhead)) && this.boostCooldown <= 0 && v.getNitroFraction() > 0.3
    input.boost = wantBoost
    if (wantBoost && v.getNitroFraction() < 0.05) this.boostCooldown = 6

    return input
  }
}
