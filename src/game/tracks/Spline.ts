/**
 * Closed / open Catmull-Rom spline with uniform arc-length resampling.
 * Produces a dense array of `SplineSample`s (position, tangent, right, up,
 * curvature, cumulative distance) that the track builder, AI racing line,
 * minimap and progress tracker all share.
 */

import * as THREE from 'three'

export interface SplineSample {
  position: THREE.Vector3
  tangent: THREE.Vector3
  right: THREE.Vector3
  up: THREE.Vector3
  /** Signed curvature (1/m), positive = turning left. */
  curvature: number
  distance: number
  /** Normalised parameter 0..1 along the whole spline. */
  t: number
  /** Bank angle in radians applied to the road cross-section. */
  bank: number
}

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

export class TrackSpline {
  readonly curve: THREE.CatmullRomCurve3
  readonly samples: SplineSample[] = []
  readonly length: number
  readonly closed: boolean
  private readonly spacing: number
  /** Coarse spatial hash for nearest-sample queries. */
  private readonly grid = new Map<string, number[]>()
  private readonly cell = 40

  constructor(points: THREE.Vector3[], closed = true, spacing = 2, tension = 0.5) {
    this.closed = closed
    this.spacing = spacing
    this.curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal', tension)
    this.curve.arcLengthDivisions = Math.max(400, points.length * 40)
    this.length = this.curve.getLength()
    const count = Math.max(8, Math.floor(this.length / spacing))
    const up = new THREE.Vector3(0, 1, 0)
    for (let i = 0; i < count; i++) {
      const u = i / count
      const position = this.curve.getPointAt(u)
      const tangent = this.curve.getTangentAt(u).normalize()
      const right = _a.crossVectors(up, tangent).normalize().clone()
      const norm = _b.crossVectors(tangent, right).normalize().clone()
      this.samples.push({ position, tangent, right, up: norm, curvature: 0, distance: u * this.length, t: u, bank: 0 })
    }
    if (!closed) {
      const position = this.curve.getPointAt(1)
      const tangent = this.curve.getTangentAt(1).normalize()
      const right = _a.crossVectors(up, tangent).normalize().clone()
      const norm = _b.crossVectors(tangent, right).normalize().clone()
      this.samples.push({ position, tangent, right, up: norm, curvature: 0, distance: this.length, t: 1, bank: 0 })
    }
    this.computeCurvature()
    this.buildGrid()
  }

  private computeCurvature(): void {
    const n = this.samples.length
    for (let i = 0; i < n; i++) {
      const prev = this.samples[this.wrapIndex(i - 2)]
      const next = this.samples[this.wrapIndex(i + 2)]
      const s = this.samples[i]
      const a = Math.atan2(prev.tangent.x, prev.tangent.z)
      const b = Math.atan2(next.tangent.x, next.tangent.z)
      let d = b - a
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      const ds = Math.max(1e-3, next.distance - prev.distance + (next.distance < prev.distance ? this.length : 0))
      s.curvature = d / ds
    }
    // Smooth curvature (moving average) and derive banking from it.
    const raw = this.samples.map((s) => s.curvature)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let k = -4; k <= 4; k++) sum += raw[this.wrapIndex(i + k)]
      this.samples[i].curvature = sum / 9
      this.samples[i].bank = THREE.MathUtils.clamp(this.samples[i].curvature * 2.5, -0.05, 0.05)
    }
    // Apply banking to right/up vectors.
    for (const s of this.samples) {
      if (Math.abs(s.bank) < 1e-4) continue
      const q = new THREE.Quaternion().setFromAxisAngle(s.tangent, s.bank)
      s.right.applyQuaternion(q)
      s.up.applyQuaternion(q)
    }
  }

  private buildGrid(): void {
    this.samples.forEach((s, i) => {
      const key = this.cellKey(s.position.x, s.position.z)
      let arr = this.grid.get(key)
      if (!arr) {
        arr = []
        this.grid.set(key, arr)
      }
      arr.push(i)
    })
  }

  private cellKey(x: number, z: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`
  }

  wrapIndex(i: number): number {
    const n = this.samples.length
    if (this.closed) return ((i % n) + n) % n
    return Math.max(0, Math.min(n - 1, i))
  }

  get count(): number {
    return this.samples.length
  }

  sampleAt(index: number): SplineSample {
    return this.samples[this.wrapIndex(index)]
  }

  /** Sample at an arc-length distance (wraps for closed splines). */
  atDistance(distance: number): SplineSample {
    let d = distance
    if (this.closed) d = ((d % this.length) + this.length) % this.length
    else d = Math.max(0, Math.min(this.length, d))
    return this.samples[this.wrapIndex(Math.round(d / this.spacing))]
  }

  atT(t: number): SplineSample {
    return this.atDistance(t * this.length)
  }

  /** Interpolated position at distance (smooth, used for cameras/minimap). */
  positionAt(distance: number, out = new THREE.Vector3()): THREE.Vector3 {
    let d = distance
    if (this.closed) d = ((d % this.length) + this.length) % this.length
    const u = Math.max(0, Math.min(0.99999, d / this.length))
    return this.curve.getPointAt(u, out)
  }

  /**
   * Nearest sample index to a world position. With a `hint` index the search
   * is a local window (fast, used every frame per vehicle); without, a spatial
   * hash lookup is used followed by a global fallback.
   */
  nearestIndex(pos: THREE.Vector3, hint?: number, window = 40): number {
    let best = -1
    let bestD = Infinity
    if (hint !== undefined && hint >= 0) {
      for (let k = -window; k <= window; k++) {
        const i = this.wrapIndex(hint + k)
        const d = this.samples[i].position.distanceToSquared(pos)
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      // If we drifted far from the hinted region (e.g. shortcut), fall through to global.
      if (bestD < 60 * 60) return best
    }
    const cx = Math.floor(pos.x / this.cell)
    const cz = Math.floor(pos.z / this.cell)
    best = -1
    bestD = Infinity
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const arr = this.grid.get(`${cx + dx},${cz + dz}`)
        if (!arr) continue
        for (const i of arr) {
          const d = this.samples[i].position.distanceToSquared(pos)
          if (d < bestD) {
            bestD = d
            best = i
          }
        }
      }
    }
    if (best >= 0) return best
    for (let i = 0; i < this.samples.length; i++) {
      const d = this.samples[i].position.distanceToSquared(pos)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  /** Signed lateral offset of `pos` from the centreline at sample `i` (positive = right). */
  lateralOffset(pos: THREE.Vector3, i: number): number {
    const s = this.samples[this.wrapIndex(i)]
    return _a.copy(pos).sub(s.position).dot(s.right)
  }

  /** Distance along the spline for a world position (uses nearest sample + projection). */
  progressAt(pos: THREE.Vector3, hint?: number): { index: number; distance: number; lateral: number } {
    const i = this.nearestIndex(pos, hint)
    const s = this.samples[i]
    const along = _a.copy(pos).sub(s.position).dot(s.tangent)
    let distance = s.distance + along
    if (this.closed) distance = ((distance % this.length) + this.length) % this.length
    return { index: i, distance, lateral: this.lateralOffset(pos, i) }
  }

  /** Max |curvature| within a distance window ahead (for AI speed planning). */
  maxCurvatureAhead(index: number, meters: number): number {
    const steps = Math.ceil(meters / this.spacing)
    let m = 0
    for (let k = 0; k < steps; k++) m = Math.max(m, Math.abs(this.sampleAt(index + k).curvature))
    return m
  }

  bounds(): THREE.Box3 {
    const box = new THREE.Box3()
    for (const s of this.samples) box.expandByPoint(s.position)
    return box
  }
}
