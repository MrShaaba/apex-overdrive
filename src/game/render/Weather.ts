/**
 * Weather simulation: current condition, transitions and surface state.
 * Wetness builds up while it rains and dries afterwards; snow cover behaves the
 * same in cold conditions; ice appears on glacier tracks when cold and dry.
 * `gripState()` is consumed by every vehicle controller each step.
 */

import { bus } from '../core/EventBus'
import { clamp01, damp } from '../core/MathUtils'
import type { WeatherGripState } from '../physics/Surfaces'
import type { WeatherKind } from '../tracks/TrackCatalog'

export interface WeatherVisualState {
  kind: WeatherKind
  cloudCover: number
  precipitation: 'none' | 'rain' | 'snow'
  precipIntensity: number
  fogMultiplier: number
  wetness: number
  snowCover: number
  iceCover: number
  lightning: number
  windStrength: number
  transition: number
}

interface WeatherTarget {
  cloud: number
  precip: 'none' | 'rain' | 'snow'
  precipIntensity: number
  fog: number
  wind: number
  cold: boolean
}

const TARGETS: Record<WeatherKind, WeatherTarget> = {
  clear: { cloud: 0.05, precip: 'none', precipIntensity: 0, fog: 1, wind: 0.2, cold: false },
  cloudy: { cloud: 0.45, precip: 'none', precipIntensity: 0, fog: 1.15, wind: 0.35, cold: false },
  overcast: { cloud: 0.9, precip: 'none', precipIntensity: 0, fog: 1.4, wind: 0.45, cold: false },
  rain: { cloud: 0.95, precip: 'rain', precipIntensity: 0.65, fog: 1.9, wind: 0.6, cold: false },
  storm: { cloud: 1, precip: 'rain', precipIntensity: 1, fog: 2.4, wind: 1, cold: false },
  fog: { cloud: 0.7, precip: 'none', precipIntensity: 0, fog: 4.5, wind: 0.1, cold: false },
  snow: { cloud: 0.9, precip: 'snow', precipIntensity: 0.6, fog: 2.0, wind: 0.4, cold: true },
  blizzard: { cloud: 1, precip: 'snow', precipIntensity: 1, fog: 3.6, wind: 1, cold: true },
}

export class WeatherSystem {
  readonly state: WeatherVisualState
  private target: WeatherTarget
  private changeTimer: number
  private lightningTimer = 0
  private readonly options: WeatherKind[]
  dynamic: boolean
  private readonly isSnowTrack: boolean

  constructor(initial: WeatherKind, options: WeatherKind[], dynamic: boolean, isSnowTrack: boolean) {
    this.options = options.length ? options : ['clear']
    this.dynamic = dynamic
    this.isSnowTrack = isSnowTrack
    this.target = TARGETS[initial]
    this.state = {
      kind: initial,
      cloudCover: this.target.cloud,
      precipitation: this.target.precip,
      precipIntensity: this.target.precipIntensity,
      fogMultiplier: this.target.fog,
      wetness: this.target.precip === 'rain' ? 0.8 : 0,
      snowCover: isSnowTrack ? 0.75 : this.target.precip === 'snow' ? 0.4 : 0,
      iceCover: isSnowTrack ? 0.15 : 0,
      lightning: 0,
      windStrength: this.target.wind,
      transition: 1,
    }
    this.changeTimer = 90 + Math.random() * 120
  }

  setWeather(kind: WeatherKind, immediate = false): void {
    this.target = TARGETS[kind]
    this.state.kind = kind
    if (immediate) {
      this.state.cloudCover = this.target.cloud
      this.state.precipitation = this.target.precip
      this.state.precipIntensity = this.target.precipIntensity
      this.state.fogMultiplier = this.target.fog
      this.state.wetness = this.target.precip === 'rain' ? 0.8 : 0
      this.state.windStrength = this.target.wind
    }
    bus.emit('weather:change', { weather: kind, intensity: this.target.precipIntensity })
  }

  update(dt: number): void {
    const s = this.state
    const t = this.target
    if (this.dynamic) {
      this.changeTimer -= dt
      if (this.changeTimer <= 0) {
        this.changeTimer = 100 + Math.random() * 140
        const next = this.options[Math.floor(Math.random() * this.options.length)]
        if (next !== s.kind) this.setWeather(next)
      }
    }
    s.cloudCover = damp(s.cloudCover, t.cloud, 0.08, dt)
    s.fogMultiplier = damp(s.fogMultiplier, t.fog, 0.08, dt)
    s.windStrength = damp(s.windStrength, t.wind, 0.1, dt)
    if (t.precip !== 'none') s.precipitation = t.precip
    s.precipIntensity = damp(s.precipIntensity, t.precipIntensity, 0.12, dt)
    if (s.precipIntensity < 0.02 && t.precip === 'none') s.precipitation = 'none'

    // Surface water: rain wets at ~1/25s; dries in ~2 minutes of clear sky.
    if (s.precipitation === 'rain') s.wetness = clamp01(s.wetness + s.precipIntensity * dt * 0.04)
    else s.wetness = clamp01(s.wetness - dt * (0.008 + (1 - s.cloudCover) * 0.006))
    if (s.precipitation === 'snow') s.snowCover = clamp01(s.snowCover + s.precipIntensity * dt * 0.02)
    else if (!this.isSnowTrack) s.snowCover = clamp01(s.snowCover - dt * 0.01)
    else s.snowCover = Math.max(0.6, s.snowCover - dt * 0.004)
    if (this.isSnowTrack) s.iceCover = damp(s.iceCover, t.cold ? 0.15 : 0.25, 0.02, dt)

    // Lightning in storms.
    if (s.kind === 'storm' && s.precipIntensity > 0.6) {
      this.lightningTimer -= dt
      if (this.lightningTimer <= 0) {
        s.lightning = 1
        this.lightningTimer = 4 + Math.random() * 12
      }
    }
    s.lightning = damp(s.lightning, 0, 9, dt)
    s.transition = damp(s.transition, 1, 0.5, dt)
  }

  gripState(): WeatherGripState {
    return { wetness: this.state.wetness, snowCover: this.state.snowCover, iceCover: this.state.iceCover }
  }
}
