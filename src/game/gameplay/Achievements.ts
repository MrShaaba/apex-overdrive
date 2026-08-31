/**
 * Accomplishments. Each achievement has a predicate over the profile plus an
 * optional last-race context; `evaluate()` is run after every race and on
 * garage actions.
 */

import { bus, type RaceResultSummary } from '../core/EventBus'
import { saveManager, type PlayerProfile } from '../persistence/SaveManager'
import { VEHICLE_CATALOG } from '../vehicles/VehicleCatalog'
import { TRACK_CATALOG } from '../tracks/TrackCatalog'

export interface AchievementDef {
  id: string
  title: string
  description: string
  icon: string
  xp: number
  check: (p: PlayerProfile, ctx: RaceContext | null) => boolean
}

export interface RaceContext {
  result: RaceResultSummary
  wet: boolean
  night: boolean
  topSpeedKmh: number
  crashes: number
  overtakes: number
  mode: string
  damage: number
  aiCount: number
  difficulty: string
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first-race', title: 'Green Flag', description: 'Finish your first race.', icon: '🏁', xp: 200, check: (p) => p.stats.racesEntered >= 1 },
  { id: 'first-win', title: 'Top Step', description: 'Win a race.', icon: '🥇', xp: 500, check: (p) => p.stats.racesWon >= 1 },
  { id: 'podium-10', title: 'Regular', description: 'Ten podium finishes.', icon: '🍾', xp: 800, check: (p) => p.stats.podiums >= 10 },
  { id: 'win-10', title: 'Serial Winner', description: 'Win ten races.', icon: '🏆', xp: 1500, check: (p) => p.stats.racesWon >= 10 },
  { id: 'clean-win', title: 'Not a Scratch', description: 'Win a race with under 10% damage against 9+ rivals.', icon: '✨', xp: 900, check: (_, c) => !!c && c.result.playerPosition === 1 && c.damage < 0.1 && c.aiCount >= 9 },
  { id: 'wet-win', title: 'Rain Master', description: 'Win a race in the wet.', icon: '🌧️', xp: 700, check: (_, c) => !!c && c.result.playerPosition === 1 && c.wet },
  { id: 'night-win', title: 'Night Owl', description: 'Win a race at night.', icon: '🌙', xp: 700, check: (_, c) => !!c && c.result.playerPosition === 1 && c.night },
  { id: 'speed-300', title: 'Three Hundred', description: 'Reach 300 km/h.', icon: '💨', xp: 600, check: (p) => p.stats.topSpeedKmh >= 300 },
  { id: 'speed-340', title: 'Terminal Velocity', description: 'Reach 340 km/h.', icon: '🚀', xp: 1200, check: (p) => p.stats.topSpeedKmh >= 340 },
  { id: 'drift-10k', title: 'Sideways', description: 'Bank 10,000 drift points in one event.', icon: '🌀', xp: 500, check: (_, c) => !!c && c.result.driftScore >= 10000 },
  { id: 'drift-50k', title: 'Smoke Machine', description: 'Bank 50,000 drift points in one event.', icon: '🔥', xp: 1200, check: (_, c) => !!c && c.result.driftScore >= 50000 },
  { id: 'laps-100', title: 'Century', description: 'Complete 100 laps.', icon: '💯', xp: 800, check: (p) => p.stats.lapsCompleted >= 100 },
  { id: 'distance-500', title: 'Road Trip', description: 'Drive 500 km.', icon: '🛣️', xp: 1000, check: (p) => p.stats.distanceKm >= 500 },
  { id: 'overtakes-50', title: 'Slipstreamer', description: 'Make 50 overtakes.', icon: '↪️', xp: 700, check: (p) => p.stats.overtakes >= 50 },
  { id: 'garage-3', title: 'Collector', description: 'Own three cars.', icon: '🚗', xp: 500, check: (p) => p.ownedCars.length >= 3 },
  { id: 'garage-all', title: 'Full House', description: 'Own every car.', icon: '🏛️', xp: 3000, check: (p) => VEHICLE_CATALOG.every((v) => p.ownedCars.includes(v.id)) },
  { id: 'tracks-all', title: 'World Tour', description: 'Unlock every circuit.', icon: '🌍', xp: 1500, check: (p) => TRACK_CATALOG.every((t) => p.unlockedTracks.includes(t.id)) },
  { id: 'legend-win', title: 'Giant Killer', description: 'Win against a legend-tier field on Legend difficulty.', icon: '⚔️', xp: 2500, check: (_, c) => !!c && c.result.playerPosition === 1 && c.difficulty === 'legend' && c.aiCount >= 11 },
  { id: 'endurance-win', title: 'Long Haul', description: 'Win a multi-lap endurance event.', icon: '🛠️', xp: 1500, check: (_, c) => !!c && c.mode === 'endurance' && c.result.playerPosition === 1 },
  { id: 'elimination-win', title: 'Survivor', description: 'Win a Last-Place-Out race.', icon: '💀', xp: 1000, check: (_, c) => !!c && c.mode === 'elimination' && c.result.playerPosition === 1 },
  { id: 'career-ch3', title: 'Making a Name', description: 'Reach Chapter 3 of the story.', icon: '📖', xp: 1000, check: (p) => p.career.chapter >= 2 },
  { id: 'career-complete', title: 'Apex Champion', description: 'Complete the story.', icon: '👑', xp: 5000, check: (p) => p.career.completedEvents.includes('c6-e4') },
  { id: 'level-10', title: 'Professional', description: 'Reach driver level 10.', icon: '📈', xp: 1000, check: (p) => p.level >= 10 },
  { id: 'sponsor-1', title: 'Signed', description: 'Complete a sponsor contract.', icon: '🤝', xp: 600, check: (p) => p.sponsors.completed.length >= 1 },
  { id: 'crash-100', title: 'Panel Beater', description: 'Survive 100 collisions.', icon: '🔨', xp: 400, check: (p) => p.stats.crashes >= 100 },
]

export function evaluateAchievements(ctx: RaceContext | null): AchievementDef[] {
  const p = saveManager.get()
  const unlocked: AchievementDef[] = []
  for (const a of ACHIEVEMENTS) {
    if (p.achievements.includes(a.id)) continue
    let ok = false
    try {
      ok = a.check(p, ctx)
    } catch {
      ok = false
    }
    if (ok) unlocked.push(a)
  }
  if (unlocked.length) {
    saveManager.update((pp) => {
      for (const a of unlocked) {
        pp.achievements.push(a.id)
        pp.xp += a.xp
      }
    })
    for (const a of unlocked) bus.emit('progress:unlock', { kind: 'achievement', id: a.id, title: `${a.icon} ${a.title}` })
  }
  return unlocked
}
