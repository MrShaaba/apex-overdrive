/**
 * Replay recorder / player. Samples every vehicle's transform at a fixed rate
 * into flat Float32 buffers (ring buffer, bounded memory). Playback interpolates
 * between samples and drives the visual entities directly, physics paused.
 * The same sample format is reused for time-trial ghosts.
 */

import * as THREE from 'three'

export const REPLAY_RATE = 20
const STRIDE = 8 // x y z qx qy qz qw steer

export interface ReplayVehicleSnapshot {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  steer: number
}

export class ReplayRecorder {
  private buffers: Float32Array[] = []
  private frames = 0
  private capacityFrames: number
  private accumulator = 0
  private vehicleCount = 0
  duration = 0
  events: { time: number; kind: string; vehicleId: number }[] = []

  constructor(maxSeconds = 600) {
    this.capacityFrames = maxSeconds * REPLAY_RATE
  }

  begin(vehicleCount: number): void {
    this.vehicleCount = vehicleCount
    this.buffers = []
    for (let i = 0; i < vehicleCount; i++) this.buffers.push(new Float32Array(this.capacityFrames * STRIDE))
    this.frames = 0
    this.duration = 0
    this.accumulator = 0
    this.events = []
  }

  record(dt: number, states: ReplayVehicleSnapshot[]): void {
    if (!this.buffers.length) return
    this.accumulator += dt
    this.duration += dt
    const step = 1 / REPLAY_RATE
    while (this.accumulator >= step) {
      this.accumulator -= step
      if (this.frames >= this.capacityFrames) return
      const f = this.frames * STRIDE
      for (let i = 0; i < this.vehicleCount; i++) {
        const s = states[i]
        const b = this.buffers[i]
        if (!s) continue
        b[f] = s.position.x
        b[f + 1] = s.position.y
        b[f + 2] = s.position.z
        b[f + 3] = s.quaternion.x
        b[f + 4] = s.quaternion.y
        b[f + 5] = s.quaternion.z
        b[f + 6] = s.quaternion.w
        b[f + 7] = s.steer
      }
      this.frames++
    }
  }

  mark(kind: string, vehicleId: number): void {
    this.events.push({ time: this.duration, kind, vehicleId })
  }

  get frameCount(): number {
    return this.frames
  }

  get length(): number {
    return this.frames / REPLAY_RATE
  }

  /** Sample vehicle `i` at time `t` (seconds), interpolated. */
  sample(i: number, t: number, out: ReplayVehicleSnapshot): boolean {
    const b = this.buffers[i]
    if (!b || this.frames < 2) return false
    const ft = Math.max(0, Math.min(this.frames - 1.0001, t * REPLAY_RATE))
    const f0 = Math.floor(ft)
    const f1 = Math.min(this.frames - 1, f0 + 1)
    const a = ft - f0
    const o0 = f0 * STRIDE
    const o1 = f1 * STRIDE
    out.position.set(b[o0] + (b[o1] - b[o0]) * a, b[o0 + 1] + (b[o1 + 1] - b[o0 + 1]) * a, b[o0 + 2] + (b[o1 + 2] - b[o0 + 2]) * a)
    const q0 = new THREE.Quaternion(b[o0 + 3], b[o0 + 4], b[o0 + 5], b[o0 + 6])
    const q1 = new THREE.Quaternion(b[o1 + 3], b[o1 + 4], b[o1 + 5], b[o1 + 6])
    out.quaternion.copy(q0).slerp(q1, a)
    out.steer = b[o0 + 7] + (b[o1 + 7] - b[o0 + 7]) * a
    return true
  }

  /** Extract a single vehicle's lap window as a ghost sample array. */
  extractGhost(i: number, fromTime: number, toTime: number): number[] {
    const out: number[] = []
    const b = this.buffers[i]
    if (!b) return out
    const f0 = Math.max(0, Math.floor(fromTime * REPLAY_RATE))
    const f1 = Math.min(this.frames - 1, Math.ceil(toTime * REPLAY_RATE))
    for (let f = f0; f <= f1; f++) {
      const o = f * STRIDE
      for (let k = 0; k < 7; k++) out.push(Math.round(b[o + k] * 1000) / 1000)
    }
    return out
  }
}

/** Plays a ghost lap (flat [x,y,z,qx,qy,qz,qw] samples) by lap-relative time. */
export class GhostPlayer {
  private readonly samples: number[]
  constructor(samples: number[], readonly sampleRate: number, readonly lapTime: number) {
    this.samples = samples
  }

  get valid(): boolean {
    return this.samples.length >= 14
  }

  sample(lapTime: number, position: THREE.Vector3, quaternion: THREE.Quaternion): boolean {
    const n = this.samples.length / 7
    if (n < 2) return false
    const ft = Math.max(0, Math.min(n - 1.0001, lapTime * this.sampleRate))
    const f0 = Math.floor(ft)
    const f1 = Math.min(n - 1, f0 + 1)
    const a = ft - f0
    const s = this.samples
    const o0 = f0 * 7
    const o1 = f1 * 7
    position.set(s[o0] + (s[o1] - s[o0]) * a, s[o0 + 1] + (s[o1 + 1] - s[o0 + 1]) * a, s[o0 + 2] + (s[o1 + 2] - s[o0 + 2]) * a)
    quaternion.set(s[o0 + 3], s[o0 + 4], s[o0 + 5], s[o0 + 6]).slerp(new THREE.Quaternion(s[o1 + 3], s[o1 + 4], s[o1 + 5], s[o1 + 6]), a)
    return true
  }
}
