/**
 * Camera rig with chase / far chase / cockpit / hood / cinematic / replay /
 * photo modes. Adds speed-reactive field of view, impact shake, velocity
 * feedback (lag + lean) and free orbit for photo mode.
 */

import * as THREE from 'three'
import type { CameraMode } from '../core/Settings'
import { clamp, damp, lerp } from '../core/MathUtils'
import { bus } from '../core/EventBus'

export interface CameraTarget {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  velocity: THREE.Vector3
  forward: THREE.Vector3
  up: THREE.Vector3
  speedKmh: number
  gLat: number
  gLong: number
  boosting: boolean
  bodyHeight: number
  bodyLength: number
  cockpitOffset: THREE.Vector3
  /** Optional hood/T-cam override in car-local space (used by open-wheelers). */
  hoodOffset?: THREE.Vector3
}

const CYCLE: CameraMode[] = ['chase', 'chaseFar', 'hood', 'cockpit', 'cinematic']

const _desired = new THREE.Vector3()
const _look = new THREE.Vector3()
const _tmp = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _flatFwd = new THREE.Vector3()

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera
  mode: CameraMode = 'chase'
  fovBase = 62
  readonly velocity = new THREE.Vector3()
  private prevPos = new THREE.Vector3()
  private shakeAmount = 0
  private shakeTime = 0
  private orbitYaw = 0
  private orbitPitch = 0.25
  private orbitDistance = 6
  private orbitTarget = new THREE.Vector3()
  private smoothedPos = new THREE.Vector3()
  private smoothedLook = new THREE.Vector3()
  private initialised = false
  private cinematicIndex = -1
  private cinematicTimer = 0
  private replayTimer = 0
  private replayShot = 0
  /** Trackside cinematic camera positions supplied by the track builder. */
  tracksideCameras: THREE.Vector3[] = []
  lookBack = false
  private fovCurrent = 62
  private rollCurrent = 0

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.fovBase, aspect, 0.2, 3000)
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.initialised = false
    if (mode === 'photo') {
      this.orbitYaw = Math.PI * 0.75
      this.orbitPitch = 0.2
      this.orbitDistance = 7
    }
    bus.emit('camera:change', { mode })
  }

  cycle(): void {
    const i = CYCLE.indexOf(this.mode)
    this.setMode(CYCLE[(i + 1) % CYCLE.length])
  }

  shake(intensity: number): void {
    this.shakeAmount = Math.min(1.5, this.shakeAmount + intensity)
  }

  orbit(dx: number, dy: number, dzoom = 0): void {
    this.orbitYaw -= dx
    this.orbitPitch = clamp(this.orbitPitch + dy, -0.3, 1.3)
    this.orbitDistance = clamp(this.orbitDistance + dzoom, 2.5, 30)
  }

  update(dt: number, target: CameraTarget, orbitInput: { x: number; y: number }): void {
    const cam = this.camera
    this.prevPos.copy(cam.position)
    const speedFactor = clamp(target.speedKmh / 300, 0, 1)

    // Flat forward direction for chase cameras (ignore pitch/roll of the chassis).
    _flatFwd.copy(target.forward)
    _flatFwd.y = 0
    if (_flatFwd.lengthSq() < 1e-4) _flatFwd.set(0, 0, 1)
    _flatFwd.normalize()
    if (this.lookBack && (this.mode === 'chase' || this.mode === 'chaseFar')) _flatFwd.multiplyScalar(-1)

    // Player orbit on chase cams: temporary yaw offset that recentres.
    if (Math.abs(orbitInput.x) > 0.0005 && (this.mode === 'chase' || this.mode === 'chaseFar')) this.orbitYaw += orbitInput.x
    else if (this.mode === 'chase' || this.mode === 'chaseFar') this.orbitYaw = damp(this.orbitYaw, 0, 3, dt)
    if (this.mode === 'photo') {
      this.orbit(orbitInput.x, orbitInput.y)
    }

    let fovTarget = this.fovBase
    let lagRate = 6
    let rollTarget = 0
    switch (this.mode) {
      case 'chase':
      case 'chaseFar': {
        const far = this.mode === 'chaseFar'
        const dist = (far ? 9.5 : 7.2) + speedFactor * (far ? 1.5 : 1.2) + target.bodyLength * 0.35
        // Scale camera height with the car so low open-wheelers fill the frame.
        const height = (far ? 3.4 : 2.6) + speedFactor * 0.2 + (target.bodyHeight - 1.3) * 1.1
        _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw)
        _tmp.copy(_flatFwd).applyQuaternion(_q)
        _desired.copy(target.position).addScaledVector(_tmp, -dist)
        _desired.y = target.position.y + height
        _look.copy(target.position).addScaledVector(_tmp, 3 + speedFactor * 4)
        _look.y += 0.35 + target.bodyHeight * 0.18
        fovTarget = this.fovBase + speedFactor * 18 + (target.boosting ? 6 : 0)
        lagRate = far ? 5 : 7 - speedFactor * 1.5
        rollTarget = -target.gLat * 0.02
        break
      }
      case 'hood': {
        if (target.hoodOffset) _desired.copy(target.position).add(_tmp.copy(target.hoodOffset).applyQuaternion(target.quaternion))
        else _desired.copy(target.position).addScaledVector(target.forward, target.bodyLength * 0.28).addScaledVector(target.up, target.bodyHeight * 0.45)
        _look.copy(_desired).addScaledVector(target.forward, 20)
        fovTarget = this.fovBase + 4 + speedFactor * 12
        lagRate = 40
        break
      }
      case 'cockpit': {
        _desired.copy(target.position).add(_tmp.copy(target.cockpitOffset).applyQuaternion(target.quaternion))
        _look.copy(_desired).addScaledVector(target.forward, 20).addScaledVector(target.up, -0.3)
        fovTarget = this.fovBase + 2 + speedFactor * 10
        lagRate = 60
        rollTarget = 0
        break
      }
      case 'cinematic':
      case 'replay': {
        this.updateCinematic(dt, target)
        return
      }
      case 'photo': {
        this.orbitTarget.lerp(target.position, 1 - Math.exp(-10 * dt))
        _desired.set(
          this.orbitTarget.x + Math.sin(this.orbitYaw) * Math.cos(this.orbitPitch) * this.orbitDistance,
          this.orbitTarget.y + Math.sin(this.orbitPitch) * this.orbitDistance + 0.5,
          this.orbitTarget.z + Math.cos(this.orbitYaw) * Math.cos(this.orbitPitch) * this.orbitDistance,
        )
        _look.copy(this.orbitTarget).addScaledVector(target.up, 0.4)
        fovTarget = this.fovBase
        lagRate = 30
        break
      }
    }

    if (!this.initialised) {
      this.smoothedPos.copy(_desired)
      this.smoothedLook.copy(_look)
      this.initialised = true
    } else {
      const k = 1 - Math.exp(-lagRate * dt)
      this.smoothedPos.lerp(_desired, k)
      this.smoothedLook.lerp(_look, 1 - Math.exp(-Math.max(lagRate, 12) * dt))
    }
    cam.position.copy(this.smoothedPos)
    cam.lookAt(this.smoothedLook)

    // Shake.
    if (this.shakeAmount > 0.001) {
      this.shakeTime += dt * 40
      const s = this.shakeAmount * 0.06
      cam.position.x += Math.sin(this.shakeTime * 1.3) * s
      cam.position.y += Math.cos(this.shakeTime * 1.7) * s
      cam.rotation.z += Math.sin(this.shakeTime * 0.9) * s * 0.5
      this.shakeAmount = damp(this.shakeAmount, 0, 5, dt)
    }
    // Speed rumble.
    if (speedFactor > 0.55 && this.mode !== 'photo') {
      const r = (speedFactor - 0.55) * 0.012
      cam.position.x += (Math.random() - 0.5) * r
      cam.position.y += (Math.random() - 0.5) * r
    }
    this.rollCurrent = damp(this.rollCurrent, rollTarget, 4, dt)
    cam.rotation.z += this.rollCurrent
    this.fovCurrent = damp(this.fovCurrent, fovTarget, 5, dt)
    cam.fov = this.fovCurrent
    cam.updateProjectionMatrix()
    this.velocity.copy(cam.position).sub(this.prevPos).divideScalar(Math.max(dt, 1e-3))
  }

  private updateCinematic(dt: number, target: CameraTarget): void {
    const cam = this.camera
    const isReplay = this.mode === 'replay'
    this.cinematicTimer -= dt
    this.replayTimer -= dt
    if (isReplay && this.replayTimer <= 0) {
      this.replayTimer = 4 + Math.random() * 4
      this.replayShot = (this.replayShot + 1) % 4
    }
    const shot = isReplay ? this.replayShot : 0
    if (shot === 0 || shot === 2) {
      // Trackside: pick the nearest camera that is ahead when the current one is passed.
      let best = this.cinematicIndex
      const current = best >= 0 ? this.tracksideCameras[best] : null
      const needNew = !current || current.distanceTo(target.position) > 140 || (current.clone().sub(target.position).dot(target.forward) < -25) || this.cinematicTimer <= 0
      if (needNew && this.tracksideCameras.length) {
        let bestScore = Infinity
        this.tracksideCameras.forEach((c, i) => {
          const toCam = _tmp.copy(c).sub(target.position)
          const d = toCam.length()
          const ahead = toCam.dot(target.forward)
          const score = d + (ahead < 0 ? 300 : 0) + (i === this.cinematicIndex ? 500 : 0)
          if (d > 15 && d < 120 && score < bestScore) {
            bestScore = score
            best = i
          }
        })
        this.cinematicIndex = best
        this.cinematicTimer = 6
      }
      const c = this.tracksideCameras[this.cinematicIndex]
      if (c) {
        cam.position.lerp(c, 1 - Math.exp(-30 * dt))
        _look.copy(target.position).addScaledVector(target.velocity, 0.15)
        cam.lookAt(_look)
        const d = cam.position.distanceTo(target.position)
        cam.fov = damp(cam.fov, clamp(1800 / d, 18, 55), 3, dt)
        cam.updateProjectionMatrix()
        return
      }
    }
    // Onboard low side shot / front shot.
    const side = shot === 1 ? 1 : -1
    _tmp.set(side * 2.6, 0.5, shot === 3 ? target.bodyLength * 0.9 : -0.5).applyQuaternion(target.quaternion)
    _desired.copy(target.position).add(_tmp)
    cam.position.lerp(_desired, 1 - Math.exp(-20 * dt))
    _look.copy(target.position).addScaledVector(target.up, 0.4)
    if (shot === 3) _look.addScaledVector(target.forward, -1)
    cam.lookAt(_look)
    cam.fov = damp(cam.fov, 50, 3, dt)
    cam.updateProjectionMatrix()
    this.velocity.copy(cam.position).sub(this.prevPos).divideScalar(Math.max(dt, 1e-3))
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
  }

  /** Photo mode zoom (mouse wheel / pinch). */
  zoom(delta: number): void {
    this.orbitDistance = clamp(this.orbitDistance + delta, 2.5, 30)
  }

  photoFov(delta: number): void {
    this.fovBase = clamp(this.fovBase + delta, 15, 110)
  }

  static lerpFov(a: number, b: number, t: number): number {
    return lerp(a, b, t)
  }
}
