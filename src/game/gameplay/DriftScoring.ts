/**
 * Drift scoring: points accumulate while the car holds a slide. The chain
 * multiplier climbs with sustained angle; a short grace period lets transitions
 * (switching direction) keep the chain alive; a collision or a straight-line
 * pause banks or voids the chain.
 */

import { clamp } from '../core/MathUtils'

export interface DriftState {
  active: boolean
  current: number
  multiplier: number
  banked: number
  chainTime: number
  grace: number
  bestChain: number
  lastAngle: number
}

export class DriftScorer {
  readonly state: DriftState = { active: false, current: 0, multiplier: 1, banked: 0, chainTime: 0, grace: 0, bestChain: 0, lastAngle: 0 }
  onBank: ((points: number, multiplier: number) => void) | null = null
  onVoid: (() => void) | null = null

  update(dt: number, driftAngleRad: number, speedKmh: number, drifting: boolean): void {
    const s = this.state
    const angle = Math.abs(driftAngleRad) * (180 / Math.PI)
    const qualifies = drifting && angle > 9 && speedKmh > 28
    if (qualifies) {
      s.active = true
      s.grace = 0.9
      s.chainTime += dt
      const pts = angle * (speedKmh / 100) * 4.2 * dt
      s.current += pts * s.multiplier
      s.multiplier = clamp(1 + Math.floor(s.chainTime / 2.2) * 0.5, 1, 6)
      s.lastAngle = angle
    } else if (s.active) {
      s.grace -= dt
      if (s.grace <= 0) this.bank()
    }
  }

  bank(): void {
    const s = this.state
    if (!s.active) return
    const pts = Math.round(s.current)
    if (pts > 0) {
      s.banked += pts
      s.bestChain = Math.max(s.bestChain, pts)
      this.onBank?.(pts, s.multiplier)
    }
    this.reset()
  }

  /** Collision: lose the current chain. */
  void(): void {
    const s = this.state
    if (s.active && s.current > 0) this.onVoid?.()
    this.reset()
  }

  private reset(): void {
    const s = this.state
    s.active = false
    s.current = 0
    s.multiplier = 1
    s.chainTime = 0
    s.grace = 0
  }

  get total(): number {
    return this.state.banked
  }
}
