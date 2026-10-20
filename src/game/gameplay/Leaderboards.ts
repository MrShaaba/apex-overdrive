/**
 * Local leaderboards + lap records, with synthesized rival times so a fresh
 * profile still has a ladder to climb. The store shape mirrors what an online
 * leaderboard API would return so a remote source can be merged in later.
 */

import { saveManager, type LeaderboardEntry } from '../persistence/SaveManager'
import { allDrivers } from '../ai/DriverProfiles'
import { TRACK_BY_ID } from '../tracks/TrackCatalog'
import { createRng, hashString } from '../core/MathUtils'

export type LeaderboardScope = 'lap' | 'drift' | 'sprint'

const key = (trackId: string, scope: LeaderboardScope) => `${scope}:${trackId}`

function syntheticEntries(trackId: string, scope: LeaderboardScope): LeaderboardEntry[] {
  const track = TRACK_BY_ID[trackId]
  if (!track) return []
  const rng = createRng(hashString(trackId + scope))
  const ref = track.bestLapReference
  return allDrivers()
    .slice(0, 12)
    .map((d) => {
      const carPool = ['mercedes-amg-one', 'mclaren-f1-gtr', 'mercedes-c63-dtm', 'mercedes-sls', 'jaguar-i-type', 'mclaren-f1-gtr-longtail']
      const val = scope === 'drift' ? Math.round(12000 * d.skill + rng() * 4000) : ref * (1.02 + (1 - d.skill) * 0.32 + rng() * 0.04)
      return { name: d.name, time: val, carId: d.favouriteCar || carPool[Math.floor(rng() * carPool.length)], date: Date.now() - Math.floor(rng() * 30) * 86400000, isPlayer: false }
    })
}

export class Leaderboards {
  get(trackId: string, scope: LeaderboardScope = 'lap'): LeaderboardEntry[] {
    const stored = saveManager.get().leaderboards[key(trackId, scope)] ?? []
    const merged = [...syntheticEntries(trackId, scope), ...stored]
    merged.sort((a, b) => (scope === 'drift' ? b.time - a.time : a.time - b.time))
    return merged.slice(0, 20)
  }

  /** Submit a result; returns the resulting rank (1-based) and whether it's a PB. */
  submit(trackId: string, scope: LeaderboardScope, value: number, carId: string): { rank: number; personalBest: boolean } {
    const k = key(trackId, scope)
    const name = saveManager.get().playerName
    let personalBest = false
    saveManager.update((p) => {
      const list = p.leaderboards[k] ?? (p.leaderboards[k] = [])
      const existing = list.find((e) => e.isPlayer)
      const better = scope === 'drift' ? value > (existing?.time ?? -Infinity) : value < (existing?.time ?? Infinity)
      if (!existing) {
        list.push({ name, time: value, carId, date: Date.now(), isPlayer: true })
        personalBest = true
      } else if (better) {
        existing.time = value
        existing.carId = carId
        existing.date = Date.now()
        existing.name = name
        personalBest = true
      }
      if (scope === 'lap') {
        const rk = `${trackId}`
        const rec = p.records[rk]
        if (!rec || value < rec.time) p.records[rk] = { time: value, carId, date: Date.now(), playerName: name }
      }
    })
    const rank = this.get(trackId, scope).findIndex((e) => e.isPlayer) + 1
    return { rank: rank || 21, personalBest }
  }

  playerBest(trackId: string, scope: LeaderboardScope = 'lap'): number | null {
    const list = saveManager.get().leaderboards[key(trackId, scope)] ?? []
    return list.find((e) => e.isPlayer)?.time ?? null
  }
}

export const leaderboards = new Leaderboards()
