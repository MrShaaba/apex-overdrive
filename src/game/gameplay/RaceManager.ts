/**
 * Race director: countdown, checkpoint validation (with optional checkpoints
 * for shortcuts), lap timing, live positions, wrong-way detection, pit stops,
 * elimination timer, finishing and result summaries. Pure game logic — it reads
 * vehicle transforms and emits events; it never touches rendering.
 */

import * as THREE from 'three'
import { bus, type RaceResultEntry, type RaceResultSummary } from '../core/EventBus'
import type { BuiltTrack, GridSlot } from '../tracks/TrackBuilder'
import { GAME_MODES, type GameModeDef, type RaceConfig } from './GameModes'
import { formatTime } from '../core/MathUtils'

export type RacePhase = 'grid' | 'countdown' | 'racing' | 'finished' | 'freeroam'

export interface RacerState {
  vehicleId: number
  name: string
  carId: string
  isPlayer: boolean
  lap: number
  nextCheckpoint: number
  checkpointsHit: boolean[]
  progress: number
  totalProgress: number
  position: number
  lapTimes: number[]
  bestLap: number
  currentLapStart: number
  sectorStart: number
  sectorIndex: number
  sectorTimes: number[]
  finished: boolean
  finishTime: number
  eliminated: boolean
  wrongWay: boolean
  wrongWayTimer: number
  driftScore: number
  damage: number
  inPit: boolean
  /** In the pit lane laterally, regardless of speed — drives the auto limiter. */
  inPitLane: boolean
  pitTimer: number
  lastValidPose: GridSlot
  lastProgressSample: number
  splineIndex: number
  overtakes: number
  lastPosition: number
  gap: number
}

export interface RacerObservation {
  id: number
  position: THREE.Vector3
  forward: THREE.Vector3
  speedKmh: number
  driftScore: number
  damage: number
}

export class RaceManager {
  readonly racers = new Map<number, RacerState>()
  readonly mode: GameModeDef
  phase: RacePhase = 'grid'
  countdown = 0
  raceTime = 0
  totalLaps: number
  private eliminationTimer: number
  private finishOrder = 0
  private lastElimination = 0
  playerId = -1
  readonly length: number
  private readonly closed: boolean
  private endTimer = -1
  private standingsCache: RacerState[] = []
  private standingsDirty = true

  constructor(
    readonly track: BuiltTrack,
    readonly config: RaceConfig,
  ) {
    this.mode = GAME_MODES[config.mode]
    this.totalLaps = this.mode.pointToPoint || !track.def.closed ? 1 : Math.max(1, config.laps)
    this.length = track.spline.length
    this.closed = track.def.closed
    this.eliminationTimer = this.mode.eliminationInterval
    if (config.mode === 'freeroam') this.phase = 'freeroam'
  }

  addRacer(vehicleId: number, name: string, carId: string, isPlayer: boolean, gridSlot: GridSlot): RacerState {
    const state: RacerState = {
      vehicleId,
      name,
      carId,
      isPlayer,
      lap: this.closed ? -1 : 0,
      nextCheckpoint: 0,
      checkpointsHit: new Array(this.track.checkpoints.length).fill(false),
      progress: 0,
      totalProgress: 0,
      position: this.racers.size + 1,
      lapTimes: [],
      bestLap: Infinity,
      currentLapStart: 0,
      sectorStart: 0,
      sectorIndex: 0,
      sectorTimes: [],
      finished: false,
      finishTime: Infinity,
      eliminated: false,
      wrongWay: false,
      wrongWayTimer: 0,
      driftScore: 0,
      damage: 0,
      inPit: false,
      inPitLane: false,
      pitTimer: 0,
      lastValidPose: gridSlot,
      lastProgressSample: 0,
      splineIndex: 0,
      overtakes: 0,
      lastPosition: this.racers.size + 1,
      gap: 0,
    }
    if (isPlayer) this.playerId = vehicleId
    this.racers.set(vehicleId, state)
    this.standingsDirty = true
    return state
  }

  get player(): RacerState | undefined {
    return this.racers.get(this.playerId)
  }

  get active(): boolean {
    return this.phase === 'racing' || this.phase === 'freeroam'
  }

  startCountdown(seconds = 3.8): void {
    if (this.phase === 'freeroam') return
    this.phase = 'countdown'
    this.countdown = seconds
    bus.emit('race:countdown', { value: Math.ceil(seconds) })
  }

  /** Per-frame update from vehicle observations. */
  update(dt: number, observations: RacerObservation[], onPitService?: (vehicleId: number, dt: number) => void): void {
    if (this.phase === 'countdown') {
      const before = Math.ceil(this.countdown)
      this.countdown -= dt
      const after = Math.ceil(this.countdown)
      if (after !== before && after > 0) bus.emit('race:countdown', { value: after })
      if (this.countdown <= 0) {
        this.phase = 'racing'
        this.raceTime = 0
        for (const r of this.racers.values()) {
          r.currentLapStart = 0
          r.sectorStart = 0
        }
        bus.emit('race:countdown', { value: 0 })
        bus.emit('race:start', { mode: this.config.mode })
      }
      // Still track progress during countdown so positions are initialised.
    }
    if (this.phase === 'grid') return
    if (this.phase === 'racing' || this.phase === 'freeroam') this.raceTime += dt

    const spline = this.track.spline
    const cps = this.track.checkpoints
    for (const o of observations) {
      const r = this.racers.get(o.id)
      if (!r || r.finished || r.eliminated) continue
      const p = spline.progressAt(o.position, r.splineIndex)
      r.splineIndex = p.index
      const prevProgress = r.progress
      r.progress = p.distance
      r.driftScore = o.driftScore
      r.damage = o.damage

      // Wrong-way detection: forward vs tangent.
      const tangent = spline.samples[p.index].tangent
      const facingBack = o.forward.dot(tangent) < -0.3 && o.speedKmh > 15
      r.wrongWayTimer = facingBack ? r.wrongWayTimer + dt : Math.max(0, r.wrongWayTimer - dt * 2)
      const wrong = r.wrongWayTimer > 1.2
      if (wrong !== r.wrongWay) {
        r.wrongWay = wrong
        if (r.isPlayer) bus.emit('race:wrongway', { vehicleId: o.id, wrongWay: wrong })
      }

      // Checkpoint crossing: detect when progress passes the next checkpoint distance.
      if (this.phase !== 'freeroam') {
        let delta = r.progress - prevProgress
        if (this.closed) {
          if (delta < -this.length / 2) delta += this.length
          if (delta > this.length / 2) delta -= this.length
        }
        if (delta > 0 && delta < 60) {
          // Check all checkpoints between prevProgress and progress (wrapping).
          for (let i = 0; i < cps.length; i++) {
            const cp = cps[i]
            let d = cp.distance - prevProgress
            if (this.closed) d = ((d % this.length) + this.length) % this.length
            if (d >= 0 && d <= delta) this.onCheckpoint(r, i, Math.abs(p.lateral) <= cp.halfWidth)
          }
        }
      }
      r.totalProgress = r.lap < 0 ? r.progress - this.length : r.lap * this.length + r.progress
      if (Math.abs(o.forward.dot(tangent)) > 0.5 && o.speedKmh < 200 && !r.wrongWay) {
        r.lastValidPose = { position: o.position.clone(), quaternion: new THREE.Quaternion() }
      }

      // Pit lane.
      const pit = this.track.pitZone
      if (pit && this.phase === 'racing') {
        const inRange = r.progress > pit.from && r.progress < pit.to
        const inLane = Math.sign(p.lateral) === pit.side && Math.abs(p.lateral) > this.track.halfWidth + 1.5 && Math.abs(p.lateral) < this.track.halfWidth + 12
        // Lane membership alone (no speed gate) — the engine hangs the
        // automatic 60 mph limiter off this, released once past the exit line.
        r.inPitLane = inRange && inLane
        const inPit = inRange && inLane && o.speedKmh < 100
        if (inPit) {
          r.pitTimer += dt
          onPitService?.(o.id, dt)
          if (!r.inPit) bus.emit('race:pit', { vehicleId: o.id, repaired: false, refueled: false })
        } else if (r.inPit) {
          bus.emit('race:pit', { vehicleId: o.id, repaired: true, refueled: true })
          r.pitTimer = 0
        }
        r.inPit = inPit
      }
    }

    this.standingsDirty = true
    this.updatePositions()

    // Elimination.
    if (this.phase === 'racing' && this.mode.eliminationInterval > 0) {
      this.eliminationTimer -= dt
      if (this.eliminationTimer <= 0) {
        this.eliminationTimer = this.mode.eliminationInterval
        this.eliminateLast()
      }
    }

    // End conditions.
    if (this.phase === 'racing') {
      const player = this.player
      const remaining = [...this.racers.values()].filter((r) => !r.finished && !r.eliminated)
      const playerDone = !player || player.finished || player.eliminated
      if (playerDone && this.endTimer < 0) this.endTimer = player?.eliminated ? 2.5 : 6
      if (this.endTimer >= 0) {
        this.endTimer -= dt
        if (this.endTimer <= 0 || remaining.length === 0) this.finishRace()
      } else if (remaining.length === 0) this.finishRace()
    }
  }

  get eliminationCountdown(): number {
    return this.eliminationTimer
  }

  private onCheckpoint(r: RacerState, index: number, onTrack: boolean): void {
    const cps = this.track.checkpoints
    if (index === 0) {
      // Start / finish line. Lap counts only if every required checkpoint was hit.
      const allRequired = cps.every((cp, i) => i === 0 || !cp.required || r.checkpointsHit[i])
      if (r.lap < 0) {
        // Leaving the grid across the line — the race proper starts here.
        r.lap = 0
        r.currentLapStart = this.raceTime
        r.sectorStart = this.raceTime
        r.sectorIndex = 0
        r.checkpointsHit.fill(false)
        r.checkpointsHit[0] = true
        r.nextCheckpoint = 1
        return
      }
      if (allRequired || !this.closed) {
        const lapTime = this.raceTime - r.currentLapStart
        r.lapTimes.push(lapTime)
        const best = lapTime < r.bestLap
        if (best) r.bestLap = lapTime
        r.lap++
        r.currentLapStart = this.raceTime
        r.sectorStart = this.raceTime
        r.sectorIndex = 0
        bus.emit('race:lap', { vehicleId: r.vehicleId, lap: r.lap, lapTime, best })
        if (r.isPlayer) bus.emit('race:message', { text: `LAP ${formatTime(lapTime)}${best && r.lapTimes.length > 1 ? ' — PERSONAL BEST' : ''}`, kind: best ? 'good' : 'info', ttl: 2.5 })
        if (r.lap >= this.totalLaps) this.finishRacer(r)
      } else if (r.isPlayer) {
        bus.emit('race:message', { text: 'CHECKPOINT MISSED — LAP INVALID', kind: 'bad', ttl: 2.5 })
        r.currentLapStart = this.raceTime
      }
      r.checkpointsHit.fill(false)
      r.checkpointsHit[0] = true
      r.nextCheckpoint = 1
      return
    }
    if (!onTrack) return
    r.checkpointsHit[index] = true
    r.nextCheckpoint = index + 1
    if (r.isPlayer) bus.emit('race:checkpoint', { vehicleId: r.vehicleId, index })
    // Sectors.
    const sectors = this.track.sectorDistances
    const cp = cps[index]
    const si = sectors.findIndex((sd) => Math.abs(sd - cp.distance) < this.length / cps.length)
    if (si >= 0 && si === r.sectorIndex) {
      r.sectorTimes[si] = this.raceTime - r.sectorStart
      r.sectorStart = this.raceTime
      r.sectorIndex++
    }
    // Point-to-point finish at the last checkpoint.
    if (!this.closed && index === cps.length - 1) {
      const lapTime = this.raceTime - r.currentLapStart
      r.lapTimes.push(lapTime)
      r.bestLap = Math.min(r.bestLap, lapTime)
      r.lap = 1
      this.finishRacer(r)
    }
  }

  private finishRacer(r: RacerState): void {
    if (r.finished) return
    r.finished = true
    r.finishTime = this.raceTime
    this.finishOrder++
    r.position = this.finishOrder
    bus.emit('race:finish', { vehicleId: r.vehicleId, position: r.position, totalTime: r.finishTime })
    if (r.isPlayer) bus.emit('race:message', { text: this.mode.scoring === 'position' ? `FINISHED P${r.position}` : 'FINISHED', kind: r.position <= 3 ? 'good' : 'info', ttl: 4 })
  }

  private eliminateLast(): void {
    const alive = this.standings().filter((r) => !r.finished && !r.eliminated)
    if (alive.length <= 1) return
    const last = alive[alive.length - 1]
    last.eliminated = true
    last.finishTime = this.raceTime
    // Eliminated racers rank below everyone still alive: assign from the bottom.
    last.position = this.racers.size - this.lastElimination
    this.lastElimination++
    bus.emit('race:eliminated', { vehicleId: last.vehicleId })
    bus.emit('race:message', { text: `${last.name.toUpperCase()} ELIMINATED`, kind: last.isPlayer ? 'bad' : 'warn', ttl: 2.5 })
    if (alive.length - 1 === 1) {
      const winner = alive[0]
      if (!winner.finished) this.finishRacer(winner)
    }
  }

  standings(): RacerState[] {
    if (!this.standingsDirty) return this.standingsCache
    const arr = [...this.racers.values()]
    arr.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1
      if (a.finished && b.finished) return a.position - b.position
      if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1
      if (a.eliminated && b.eliminated) return a.position - b.position
      if (this.mode.scoring === 'drift') return b.driftScore - a.driftScore
      return b.totalProgress - a.totalProgress
    })
    this.standingsCache = arr
    this.standingsDirty = false
    return arr
  }

  private updatePositions(): void {
    const s = this.standings()
    const leader = s[0]
    s.forEach((r, i) => {
      const pos = i + 1
      if (!r.finished && !r.eliminated) {
        if (r.lastPosition > pos && this.phase === 'racing') r.overtakes += r.lastPosition - pos > 3 ? 0 : 1
        if (pos !== r.position) {
          r.position = pos
          if (r.isPlayer) bus.emit('race:position', { vehicleId: r.vehicleId, position: pos })
        }
        r.lastPosition = pos
      }
      r.gap = leader ? (leader.totalProgress - r.totalProgress) : 0
    })
  }

  private finishRace(): void {
    if (this.phase === 'finished') return
    this.phase = 'finished'
    // Classify anyone still running by current order.
    const s = this.standings()
    let pos = 1
    for (const r of s) if (r.finished) pos = Math.max(pos, r.position + 1)
    for (const r of s) {
      if (!r.finished && !r.eliminated) {
        r.position = pos++
        r.finishTime = Math.max(r.finishTime === Infinity ? 0 : r.finishTime, this.raceTime + r.gap / 40)
      }
    }
    bus.emit('race:complete', { results: this.results() })
  }

  /** Force-finish (e.g. player quits) — still yields a classification. */
  abort(): RaceResultSummary {
    this.finishRace()
    return this.results()
  }

  results(): RaceResultSummary {
    const s = this.standings()
    const entries: RaceResultEntry[] = s.map((r, i) => ({
      vehicleId: r.vehicleId,
      name: r.name,
      carId: r.carId,
      position: r.finished || r.eliminated ? r.position : i + 1,
      totalTime: r.finishTime === Infinity ? this.raceTime : r.finishTime,
      bestLap: r.bestLap,
      isPlayer: r.isPlayer,
      finished: r.finished,
      eliminated: r.eliminated,
      driftScore: r.driftScore,
      damage: r.damage,
    }))
    entries.sort((a, b) => a.position - b.position)
    const player = entries.find((e) => e.isPlayer)
    return {
      mode: this.config.mode,
      trackId: this.track.def.id,
      entries,
      playerPosition: player?.position ?? entries.length,
      playerBestLap: player?.bestLap ?? Infinity,
      playerTotalTime: player?.totalTime ?? 0,
      driftScore: player?.driftScore ?? 0,
      credits: 0,
      xp: 0,
      isPersonalBest: false,
    }
  }

  /** Respawn pose: on the centreline just behind the last checkpoint hit. */
  respawnPose(vehicleId: number): GridSlot {
    const r = this.racers.get(vehicleId)
    const d = r ? r.progress - 6 : 0
    return this.track.spawnPose(this.closed ? ((d % this.length) + this.length) % this.length : Math.max(0, d), 0)
  }
}

/** Multi-round series (championship / knockout) bookkeeping. */
export interface SeriesState {
  kind: 'championship' | 'knockout'
  rounds: string[]
  round: number
  points: Record<string, number>
  names: Record<string, string>
  eliminated: string[]
  finished: boolean
}

export function createSeries(kind: 'championship' | 'knockout', tracks: string[]): SeriesState {
  return { kind, rounds: tracks, round: 0, points: {}, names: {}, eliminated: [], finished: false }
}
