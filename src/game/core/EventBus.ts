/**
 * Typed publish/subscribe event bus.
 *
 * Every cross-system message in the engine (race events, collisions, UI intents,
 * audio cues) flows through here so systems stay decoupled. The map of event
 * names → payload types lives in `GameEvents` and is the single source of truth
 * for what can be emitted.
 */

import type { Vector3Like } from './MathUtils'

export interface GameEvents {
  'engine:ready': { buildMs: number }
  'engine:error': { message: string; fatal: boolean }
  'engine:frame': { dt: number; fps: number }
  'engine:quality': { preset: string }

  'race:countdown': { value: number }
  'race:start': { mode: string }
  'race:lap': { vehicleId: number; lap: number; lapTime: number; best: boolean }
  'race:checkpoint': { vehicleId: number; index: number }
  'race:position': { vehicleId: number; position: number }
  'race:finish': { vehicleId: number; position: number; totalTime: number }
  'race:eliminated': { vehicleId: number }
  'race:complete': { results: RaceResultSummary }
  'race:wrongway': { vehicleId: number; wrongWay: boolean }
  'race:pit': { vehicleId: number; repaired: boolean; refueled: boolean }
  'race:drift': { vehicleId: number; points: number; multiplier: number; chainEnded: boolean }
  'race:message': { text: string; kind: 'info' | 'warn' | 'good' | 'bad'; ttl?: number }

  'vehicle:collision': { vehicleId: number; force: number; point: Vector3Like; normal: Vector3Like; otherVehicleId: number | null }
  'vehicle:gear': { vehicleId: number; gear: number; up: boolean }
  'vehicle:boost': { vehicleId: number; active: boolean }
  'vehicle:respawn': { vehicleId: number }
  'vehicle:turbo-blowoff': { vehicleId: number; pressure: number }

  'weather:change': { weather: string; intensity: number }
  'time:change': { hour: number }

  'camera:change': { mode: string }
  'photo:captured': { dataUrl: string }
  'replay:state': { playing: boolean; time: number; duration: number }

  'save:written': { key: string }
  'progress:levelup': { level: number; rank: string }
  'progress:unlock': { kind: 'car' | 'track' | 'sponsor' | 'achievement' | 'livery'; id: string; title: string }
  'progress:credits': { delta: number; total: number; reason: string }
  'challenge:complete': { id: string; title: string; reward: number }

  'input:action': { action: string; pressed: boolean }
  'ui:toast': { text: string; icon?: string }
}

export interface RaceResultEntry {
  vehicleId: number
  name: string
  carId: string
  position: number
  totalTime: number
  bestLap: number
  isPlayer: boolean
  finished: boolean
  eliminated: boolean
  driftScore: number
  damage: number
}

export interface RaceResultSummary {
  mode: string
  trackId: string
  entries: RaceResultEntry[]
  playerPosition: number
  playerBestLap: number
  playerTotalTime: number
  driftScore: number
  credits: number
  xp: number
  isPersonalBest: boolean
}

type Handler<T> = (payload: T) => void

export class EventBus {
  private readonly handlers = new Map<keyof GameEvents, Set<Handler<unknown>>>()

  on<K extends keyof GameEvents>(event: K, handler: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler as Handler<unknown>)
    return () => this.off(event, handler)
  }

  once<K extends keyof GameEvents>(event: K, handler: Handler<GameEvents[K]>): () => void {
    const off = this.on(event, (payload) => {
      off()
      handler(payload)
    })
    return off
  }

  off<K extends keyof GameEvents>(event: K, handler: Handler<GameEvents[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<unknown>)
  }

  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const handler of Array.from(set)) {
      try {
        handler(payload)
      } catch (err) {
        // A misbehaving listener must never break the frame loop.
        console.error(`[EventBus] handler for "${String(event)}" threw`, err)
      }
    }
  }

  clear(): void {
    this.handlers.clear()
  }
}

/** Global bus shared by the engine and the React UI layer. */
export const bus = new EventBus()
