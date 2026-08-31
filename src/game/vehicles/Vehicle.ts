/**
 * Vehicle entity: binds a physics controller, a procedural visual, an audio
 * voice, a particle emitter set and (for rivals) an AI brain. Handles render
 * interpolation, wheel visuals, lights, damage deformation and effect emission.
 */

import * as THREE from 'three'
import type { PhysicsWorld } from '../physics/PhysicsWorld'
import { VehicleController, type VehicleAssists, type VehicleInput } from '../physics/VehicleController'
import { applyUpgrades, type VehicleCustomization, type VehicleSpec, type VehicleUpgrades } from './VehicleSpec'
import { buildCarVisual, type CarVisual } from './CarMeshBuilder'
import type { TextureFactory } from '../render/TextureFactory'
import type { AudioEngine, VehicleAudioHandle } from '../audio/AudioEngine'
import type { ParticleSystem } from '../render/Particles'
import { SURFACES } from '../physics/Surfaces'
import type { AIDriver } from '../ai/AIDriver'
import { DriftScorer } from '../gameplay/DriftScoring'
import { bus } from '../core/EventBus'
import { clamp, clamp01 } from '../core/MathUtils'

export interface VehicleOptions {
  id: number
  spec: VehicleSpec
  customization: VehicleCustomization
  upgrades: VehicleUpgrades
  isPlayer: boolean
  name: string
  color: string
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  highDetail: boolean
  physics: PhysicsWorld
  scene: THREE.Object3D
  textures: TextureFactory
  audio: AudioEngine | null
  assists: VehicleAssists
  fuelEnabled: boolean
  damageEnabled: boolean
  initialDamage?: number
}

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _local = new THREE.Vector3()
const _dir = new THREE.Vector3()

export class Vehicle {
  readonly id: number
  readonly spec: VehicleSpec
  readonly tuned: VehicleSpec
  readonly customization: VehicleCustomization
  readonly isPlayer: boolean
  readonly name: string
  readonly color: string
  readonly controller: VehicleController
  readonly visual: CarVisual
  readonly audio: VehicleAudioHandle | null
  ai: AIDriver | null = null
  input: VehicleInput = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false }
  readonly drift = new DriftScorer()
  private dirt = 0
  private lastGearFlash = 0
  private headlightsOn = false
  private impactCooldown = 0
  private lastCollisionTime = 0
  crashCount = 0
  topSpeedKmh = 0
  distanceM = 0
  private lastPos = new THREE.Vector3()
  private readonly scene: THREE.Object3D

  constructor(opts: VehicleOptions) {
    this.id = opts.id
    this.spec = opts.spec
    this.customization = opts.customization
    this.tuned = applyUpgrades(opts.spec, opts.upgrades, opts.customization)
    this.isPlayer = opts.isPlayer
    this.name = opts.name
    this.color = opts.color
    this.scene = opts.scene
    this.controller = new VehicleController(opts.physics, this.tuned, opts.id, opts.position, opts.quaternion, opts.customization)
    this.controller.assists = opts.assists
    this.controller.fuelEnabled = opts.fuelEnabled
    this.controller.damageEnabled = opts.damageEnabled
    if (opts.initialDamage) this.controller.setDamage(opts.initialDamage)
    this.visual = buildCarVisual(opts.spec, opts.customization, opts.textures, opts.highDetail)
    this.visual.root.position.copy(opts.position)
    this.visual.root.quaternion.copy(opts.quaternion)
    opts.scene.add(this.visual.root)
    this.audio = opts.audio ? opts.audio.createVehicleVoice(this.tuned, opts.isPlayer) : null
    this.lastPos.copy(opts.position)

    this.controller.onGearChange = (gear, up) => {
      bus.emit('vehicle:gear', { vehicleId: this.id, gear, up })
      opts.audio?.playGearShift(up, this.isPlayer ? null : this.controller.position)
      if (up && this.spec.engine.type !== 'ev') this.lastGearFlash = 0.12
    }
    this.controller.onTurboBlowoff = (pressure) => {
      bus.emit('vehicle:turbo-blowoff', { vehicleId: this.id, pressure })
      opts.audio?.playBlowoff(pressure, this.isPlayer ? null : this.controller.position)
    }
  }

  get position(): THREE.Vector3 {
    return this.controller.position
  }

  get telemetry() {
    return this.controller.telemetry
  }

  /** Called before each physics step. */
  fixedUpdate(dt: number): void {
    this.controller.step(dt, this.input)
  }

  /** Called once per render frame. */
  update(dt: number, alpha: number, particles: ParticleSystem, wetness: number, snowCover: number, nightFactor: number, cameraPos: THREE.Vector3, audioParams: { engineVolume: number }): void {
    const c = this.controller
    const t = c.telemetry
    const root = this.visual.root
    // Interpolated transform.
    root.position.lerpVectors(c.prevPosition, c.position, alpha)
    root.quaternion.slerpQuaternions(c.prevQuaternion, c.quaternion, alpha)

    // Wheels: hub positions in world space → local.
    root.updateMatrixWorld()
    const inv = _q.copy(root.quaternion).invert()
    c.wheels.forEach((w, i) => {
      const hub = this.visual.wheels[i]
      _v.copy(w.hubWorld).sub(c.position).applyQuaternion(inv)
      hub.position.copy(_v)
      hub.rotation.set(0, w.steerAngle, 0)
      const spin = this.visual.wheelSpin[i]
      spin.rotation.x = w.rotation
    })

    // Distance / top speed stats.
    this.distanceM += this.lastPos.distanceTo(c.position)
    this.lastPos.copy(c.position)
    this.topSpeedKmh = Math.max(this.topSpeedKmh, t.speedKmh)

    // Lights.
    const wantLights = nightFactor > 0.35 || wetness > 0.6
    if (wantLights !== this.headlightsOn) {
      this.headlightsOn = wantLights
    }
    this.visual.setLights(this.headlightsOn, t.brake > 0.15 || c.telemetry.speed < -0.5, t.gear < 0)

    // Impact cooldown / flash.
    this.impactCooldown = Math.max(0, this.impactCooldown - dt)
    this.lastGearFlash = Math.max(0, this.lastGearFlash - dt)

    // Drift scoring.
    this.drift.update(dt, t.driftAngle, t.speedKmh, t.drifting)

    // Effects — only for cars near the camera to respect the particle budget.
    const camDist = c.position.distanceTo(cameraPos)
    if (camDist < 120) {
      const lod = camDist < 40 ? 1 : 0.4
      for (const w of c.wheels) {
        if (!w.contact) continue
        const surf = SURFACES[w.surface]
        const speed = Math.abs(t.speed)
        const spinning = w.spinning || w.locked
        const intensity = Math.max(w.skid, spinning ? 0.6 : 0)
        const key = `${this.id}-${w.index}`
        _v.copy(w.contactPoint)
        _v2.copy(c.velocity).multiplyScalar(0.25)
        _v2.y += 0.6
        if (wetness > 0.35 && speed > 8) {
          particles.emit('spray', _v, _v2.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, 1.2, 0)), dt * 22 * wetness * lod * clamp01(speed / 30), { size: 0.9, key: key + 's', spread: 0.5 })
        }
        if (snowCover > 0.3 && speed > 6) {
          particles.emit('snowdust', _v, _v2, dt * 14 * lod * clamp01(speed / 30) * snowCover, { key: key + 'n', spread: 0.6 })
        }
        if (intensity > 0.08) {
          const rate = intensity * 22 * dt * lod
          if (surf.particle === 'smoke' && wetness < 0.5) particles.emit('smoke', _v, _v2.clone().add(new THREE.Vector3(0, 0.8, 0)), rate, { size: 1 + intensity, key, spread: 0.6 })
          else if (surf.particle === 'dust') particles.emit('dust', _v, _v2, rate * 1.2, { size: 1.2, key, spread: 0.8 })
          else if (surf.particle === 'gravel') {
            particles.emit('dust', _v, _v2, rate, { size: 1.1, key, spread: 0.8 })
            particles.emit('gravel', _v, _v2.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 3, (Math.random() - 0.5) * 4)), rate * 0.6, { key: key + 'g', spread: 0.4 })
          } else if (surf.particle === 'grass') particles.emit('grass', _v, _v2.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 2.5, (Math.random() - 0.5) * 3)), rate * 0.8, { key: key + 'g', spread: 0.5 })
          else if (surf.particle === 'snow') particles.emit('snowdust', _v, _v2, rate, { key, spread: 0.7 })
          else if (surf.particle === 'spray') particles.emit('spray', _v, _v2.clone().add(new THREE.Vector3(0, 1.5, 0)), rate, { key, spread: 0.6 })
          this.dirt = clamp01(this.dirt + (surf.loose ? dt * 0.02 : 0))
        }
      }
      // Exhaust flames on upshift / overrun.
      if (this.spec.engine.type !== 'ev' && (this.lastGearFlash > 0 || (t.throttle < 0.05 && t.rpm > this.tuned.engine.redline * 0.7 && Math.random() < dt * 4))) {
        for (const e of this.visual.exhausts) {
          _local.copy(e).applyQuaternion(root.quaternion).add(root.position)
          _dir.copy(c.forward).multiplyScalar(-6).add(c.velocity)
          particles.emit('exhaust', _local, _dir, 2 * lod, { size: 1.2, spread: 0.08 })
        }
      }
      if (t.nitroActive) {
        for (const e of this.visual.exhausts) {
          _local.copy(e).applyQuaternion(root.quaternion).add(root.position)
          _dir.copy(c.forward).multiplyScalar(-10).add(c.velocity)
          particles.emit('exhaust', _local, _dir, dt * 60 * lod, { size: 1.6, key: `${this.id}-n`, color: new THREE.Color(0.5, 0.7, 1.2), spread: 0.1 })
        }
      }
    }

    // Audio.
    if (this.audio) {
      let skid = 0
      let kind: 'tarmac' | 'gravel' | 'snow' | 'none' = 'none'
      for (const w of c.wheels) {
        if (w.skid > skid) {
          skid = w.skid
          kind = SURFACES[w.surface].skidSound
        }
      }
      if (wetness > 0.5 && kind === 'tarmac') skid *= 0.5
      this.audio.update(
        { rpm: t.rpm, throttle: t.throttle, load: clamp01(t.throttle * 0.8 + (t.engineTorque > 0 ? 0.2 : 0)), boost: t.turboBoost, nitro: t.nitroActive, limiter: t.limiter, redline: this.tuned.engine.redline },
        skid,
        kind,
        t.nitroActive,
        c.position,
        c.velocity,
      )
      void audioParams
    }
  }

  /** Physics contact event routed by the engine. */
  onCollision(force: number, point: THREE.Vector3, normal: THREE.Vector3, otherVehicleId: number | null, particles: ParticleSystem, audio: AudioEngine | null, time: number): number {
    const mass = this.tuned.mass
    // Contact force is a peak solver force: ~mass*400 N corresponds to a hard wall hit at ~40 km/h.
    const severity = clamp(force / (mass * 400), 0, 1)
    if (severity < 0.08 || time - this.lastCollisionTime < 0.25) return 0
    this.lastCollisionTime = time
    const damage = severity * severity * (otherVehicleId !== null ? 0.07 : 0.12)
    this.controller.applyDamage(damage)
    this.crashCount += severity > 0.25 ? 1 : 0
    // Dent the body around the impact point.
    _local.copy(point).sub(this.controller.position).applyQuaternion(_q.copy(this.controller.quaternion).invert())
    _local.y -= this.visual.bodyOffsetY
    _dir.copy(normal).applyQuaternion(_q).multiplyScalar(-1)
    if (severity > 0.12) this.visual.dent(_local, _dir, severity * 0.35)
    // Sparks + debris.
    particles.burst('spark', point, Math.round(6 + severity * 40), 4 + severity * 10, { dir: normal })
    if (severity > 0.3) particles.burst('debris', point, Math.round(severity * 8), 3, { dir: normal })
    audio?.playImpact(severity * 1.3, this.isPlayer ? null : point, otherVehicleId === null)
    this.drift.void()
    bus.emit('vehicle:collision', { vehicleId: this.id, force: severity, point: { x: point.x, y: point.y, z: point.z }, normal: { x: normal.x, y: normal.y, z: normal.z }, otherVehicleId })
    return severity
  }

  respawn(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    this.controller.teleport(position, quaternion, 0)
    this.controller.repair(0.05)
    this.visual.root.position.copy(position)
    this.visual.root.quaternion.copy(quaternion)
    this.lastPos.copy(position)
    this.drift.void()
    bus.emit('vehicle:respawn', { vehicleId: this.id })
  }

  setVisible(visible: boolean): void {
    this.visual.root.visible = visible
  }

  dispose(): void {
    this.scene.remove(this.visual.root)
    this.visual.dispose()
    this.audio?.dispose()
    this.controller.dispose()
  }
}
