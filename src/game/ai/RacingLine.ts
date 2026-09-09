/**
 * Racing-line optimiser + speed profile.
 *
 * Starting from the centreline, repeatedly averages neighbouring points along
 * the path and clamps them inside the track. Averaging in world space pulls the
 * path toward the chord of every corner — producing a natural out-in-out line.
 * A reference speed profile is then generated with lateral-g and braking limits
 * (backward pass) and acceleration limits (forward pass). Individual drivers
 * scale the reference by their grip and skill.
 */

import * as THREE from 'three'
import type { TrackSpline } from '../tracks/Spline'

export class RacingLine {
  readonly offsets: Float32Array
  readonly positions: THREE.Vector3[] = []
  readonly curvature: Float32Array
  readonly referenceSpeed: Float32Array
  /** Typical lateral limit (median over the lap); `limitAt` gives the local one. */
  readonly limit: number
  private readonly limits: Float32Array

  constructor(
    readonly spline: TrackSpline,
    halfWidth: number | ((sampleIndex: number) => number),
    margin = 2.6,
    iterations = 140,
  ) {
    const n = spline.count
    this.limits = new Float32Array(n)
    for (let i = 0; i < n; i++) this.limits[i] = Math.max(0.5, (typeof halfWidth === 'number' ? halfWidth : halfWidth(i)) - margin)
    const sorted = Float32Array.from(this.limits).sort()
    this.limit = sorted[n >> 1]
    this.offsets = new Float32Array(n)
    this.curvature = new Float32Array(n)
    this.referenceSpeed = new Float32Array(n)
    this.optimise(iterations)
    this.computeCurvature()
    // 0.78 g lateral: AIDriver clamps steering to ~0.8 g of lateral acceleration, so a
    // profile assuming more sends every car wide in every corner — harmless on a 16 m
    // procedural road, a wall on a 10 m real one.
    this.computeReferenceSpeed(0.78 * 9.81, 0.8 * 9.81, 0.45 * 9.81, 95)
  }

  private optimise(iterations: number): void {
    const spline = this.spline
    const n = spline.count
    const pts = spline.samples.map((s) => s.position.clone())
    const tmp = new THREE.Vector3()
    const windows = [12, 8, 5, 3, 2]
    for (let it = 0; it < iterations; it++) {
      const w = windows[Math.min(windows.length - 1, Math.floor((it / iterations) * windows.length))]
      for (let i = 0; i < n; i++) {
        if (!spline.closed && (i < w || i >= n - w)) continue
        const a = pts[spline.wrapIndex(i - w)]
        const b = pts[spline.wrapIndex(i + w)]
        tmp.copy(a).add(b).multiplyScalar(0.5)
        // Project the smoothed point back onto the cross-section at i and clamp.
        const s = spline.samples[i]
        const lim = this.limits[i]
        const lateral = THREE.MathUtils.clamp(tmp.sub(s.position).dot(s.right), -lim, lim)
        this.offsets[i] = lateral
        pts[i].copy(s.position).addScaledVector(s.right, lateral)
      }
    }
    for (let i = 0; i < n; i++) this.positions.push(pts[i])
  }

  private computeCurvature(): void {
    const n = this.positions.length
    for (let i = 0; i < n; i++) {
      const p0 = this.positions[this.spline.wrapIndex(i - 3)]
      const p1 = this.positions[i]
      const p2 = this.positions[this.spline.wrapIndex(i + 3)]
      // Menger curvature from three points.
      const a = p0.distanceTo(p1)
      const b = p1.distanceTo(p2)
      const c = p0.distanceTo(p2)
      const s = (a + b + c) / 2
      const area = Math.sqrt(Math.max(0, s * (s - a) * (s - b) * (s - c)))
      this.curvature[i] = a * b * c > 1e-6 ? (4 * area) / (a * b * c) : 0
    }
    // Smooth.
    const raw = Float32Array.from(this.curvature)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let k = -3; k <= 3; k++) sum += raw[this.spline.wrapIndex(i + k)]
      this.curvature[i] = sum / 7
    }
  }

  private computeReferenceSpeed(aLat: number, aBrake: number, aAccel: number, vMax: number): void {
    const n = this.positions.length
    const v = this.referenceSpeed
    for (let i = 0; i < n; i++) v[i] = Math.min(vMax, Math.sqrt(aLat / Math.max(this.curvature[i], 1e-4)))
    const ds = (i: number) => Math.max(0.5, this.positions[i].distanceTo(this.positions[this.spline.wrapIndex(i + 1)]))
    // Backward pass (braking) — run twice for closed loops so the wrap is consistent.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const next = this.spline.wrapIndex(i + 1)
        const allowed = Math.sqrt(v[next] * v[next] + 2 * aBrake * ds(i))
        if (v[i] > allowed) v[i] = allowed
      }
    }
    // Forward pass (acceleration).
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const prev = this.spline.wrapIndex(i - 1)
        const allowed = Math.sqrt(v[prev] * v[prev] + 2 * aAccel * ds(prev))
        if (v[i] > allowed) v[i] = allowed
      }
    }
  }

  /** Target world position on the line at a sample index with an extra lateral bias (metres). */
  targetAt(index: number, bias: number, out: THREE.Vector3): THREE.Vector3 {
    const i = this.spline.wrapIndex(index)
    const s = this.spline.samples[i]
    const lateral = THREE.MathUtils.clamp(this.offsets[i] + bias, -this.limits[i], this.limits[i])
    return out.copy(s.position).addScaledVector(s.right, lateral)
  }

  /** Lateral limit (metres from the centreline) at a sample index. */
  limitAt(index: number): number {
    return this.limits[this.spline.wrapIndex(index)]
  }
}
