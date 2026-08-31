/**
 * Dynamic resolution scaling. Watches the smoothed frame time and nudges the
 * render scale down when the frame budget is missed for a sustained period,
 * back up when there is headroom. Never fights the user's manual preset.
 */

import { clamp } from '../core/MathUtils'

export class QualityManager {
  private smoothedMs = 16.7
  private lowTimer = 0
  private highTimer = 0
  scale = 1
  readonly min = 0.55
  private max = 1
  enabled = true
  fps = 60
  private listeners: ((scale: number) => void)[] = []

  setMaxScale(max: number): void {
    this.max = max
    this.scale = Math.min(this.scale, max)
    this.notify()
  }

  onChange(cb: (scale: number) => void): void {
    this.listeners.push(cb)
  }

  private notify(): void {
    for (const l of this.listeners) l(this.scale)
  }

  update(dtMs: number): void {
    this.smoothedMs = this.smoothedMs * 0.92 + dtMs * 0.08
    this.fps = 1000 / this.smoothedMs
    if (!this.enabled) return
    if (this.smoothedMs > 22) {
      this.lowTimer += dtMs
      this.highTimer = 0
      if (this.lowTimer > 2500 && this.scale > this.min) {
        this.scale = clamp(this.scale - 0.1, this.min, this.max)
        this.lowTimer = 0
        this.notify()
      }
    } else if (this.smoothedMs < 15.5) {
      this.highTimer += dtMs
      this.lowTimer = 0
      if (this.highTimer > 8000 && this.scale < this.max) {
        this.scale = clamp(this.scale + 0.05, this.min, this.max)
        this.highTimer = 0
        this.notify()
      }
    } else {
      this.lowTimer = Math.max(0, this.lowTimer - dtMs)
      this.highTimer = Math.max(0, this.highTimer - dtMs)
    }
  }
}
