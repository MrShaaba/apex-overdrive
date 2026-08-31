/**
 * Rotating challenges: three daily and two weekly objectives generated from a
 * date seed, so every player sees the same set on the same day without a
 * server. Progress is stored on the profile and reset when the period rolls.
 */

import { createRng, hashString } from '../core/MathUtils'
import { saveManager } from '../persistence/SaveManager'
import { bus, type RaceResultSummary } from '../core/EventBus'
import { TRACK_CATALOG } from '../tracks/TrackCatalog'
import { VEHICLE_CATALOG } from '../vehicles/VehicleCatalog'

export interface Challenge {
  id: string
  period: 'daily' | 'weekly'
  title: string
  description: string
  target: number
  reward: number
  xp: number
  kind: 'win' | 'podium' | 'drift' | 'laps' | 'topSpeed' | 'races' | 'track' | 'car' | 'clean' | 'overtakes' | 'wet'
  trackId?: string
  carId?: string
}

function periodKey(): string {
  const d = new Date()
  const day = Math.floor(d.getTime() / 86400000)
  const week = Math.floor(day / 7)
  return `${day}:${week}`
}

export function currentChallenges(): Challenge[] {
  const [day, week] = periodKey().split(':').map(Number)
  const out: Challenge[] = []
  const used = new Set<string>()
  const make = (period: 'daily' | 'weekly', seed: number, i: number): Challenge => {
    const rng = createRng(hashString(`${period}-${seed}-${i}`))
    const track = TRACK_CATALOG[Math.floor(rng() * TRACK_CATALOG.length)]
    const car = VEHICLE_CATALOG[Math.floor(rng() * VEHICLE_CATALOG.length)]
    const mult = period === 'weekly' ? 3 : 1
    const templates: Challenge[] = [
      { id: '', period, kind: 'win', title: 'Take the Win', description: `Win ${mult} race${mult > 1 ? 's' : ''}`, target: mult, reward: 6000 * mult, xp: 400 * mult },
      { id: '', period, kind: 'podium', title: 'Champagne', description: `Finish on the podium ${2 * mult} times`, target: 2 * mult, reward: 5000 * mult, xp: 350 * mult },
      { id: '', period, kind: 'drift', title: 'Smoke Show', description: `Bank ${15000 * mult} drift points`, target: 15000 * mult, reward: 5500 * mult, xp: 350 * mult },
      { id: '', period, kind: 'laps', title: 'Mileage', description: `Complete ${12 * mult} laps`, target: 12 * mult, reward: 4000 * mult, xp: 300 * mult },
      { id: '', period, kind: 'topSpeed', title: 'Speed Demon', description: `Reach ${250 + Math.floor(rng() * 6) * 10} km/h`, target: 250 + Math.floor(rng() * 6) * 10, reward: 4500 * mult, xp: 300 * mult },
      { id: '', period, kind: 'track', title: `${track.name} Regular`, description: `Finish ${2 * mult} races at ${track.name}`, target: 2 * mult, reward: 5000 * mult, xp: 350 * mult, trackId: track.id },
      { id: '', period, kind: 'car', title: `${car.name} Showcase`, description: `Finish ${2 * mult} races in the ${car.brand} ${car.name}`, target: 2 * mult, reward: 5500 * mult, xp: 350 * mult, carId: car.id },
      { id: '', period, kind: 'clean', title: 'Clean Sheet', description: `Finish ${mult} race${mult > 1 ? 's' : ''} with under 15% damage`, target: mult, reward: 5000 * mult, xp: 350 * mult },
      { id: '', period, kind: 'overtakes', title: 'Traffic', description: `Make ${10 * mult} overtakes`, target: 10 * mult, reward: 4500 * mult, xp: 300 * mult },
      { id: '', period, kind: 'wet', title: 'Rain Dance', description: `Finish ${mult} race${mult > 1 ? 's' : ''} in the wet`, target: mult, reward: 5500 * mult, xp: 350 * mult },
    ]
    let c = templates[Math.floor(rng() * templates.length)]
    let guard = 0
    while (used.has(c.kind) && guard++ < 12) c = templates[Math.floor(rng() * templates.length)]
    used.add(c.kind)
    c.id = `${period}-${seed}-${i}`
    return c
  }
  for (let i = 0; i < 3; i++) out.push(make('daily', day, i))
  for (let i = 0; i < 2; i++) out.push(make('weekly', week, i))
  return out
}

export function syncChallengePeriod(): void {
  const key = periodKey()
  const p = saveManager.get()
  if (p.challenges.period !== key) {
    const [day, week] = key.split(':')
    const [oldDay, oldWeek] = (p.challenges.period || ':').split(':')
    saveManager.update((pp) => {
      pp.challenges.period = key
      for (const id of Object.keys(pp.challenges.progress)) {
        if ((id.startsWith('daily') && oldDay !== day) || (id.startsWith('weekly') && oldWeek !== week)) delete pp.challenges.progress[id]
      }
      pp.challenges.completed = pp.challenges.completed.filter((id) => (id.startsWith('daily') ? id.includes(`-${day}-`) : id.includes(`-${week}-`)))
    })
  }
}

export function challengeProgress(c: Challenge): number {
  return saveManager.get().challenges.progress[c.id] ?? 0
}

export function applyChallengeResult(result: RaceResultSummary, ctx: { trackId: string; carId: string; laps: number; topSpeedKmh: number; damage: number; overtakes: number; wet: boolean; positionScoring: boolean }): Challenge[] {
  syncChallengePeriod()
  const completed: Challenge[] = []
  const list = currentChallenges()
  saveManager.update((p) => {
    for (const c of list) {
      if (p.challenges.completed.includes(c.id)) continue
      const cur = p.challenges.progress[c.id] ?? 0
      let next = cur
      const pos = result.playerPosition
      switch (c.kind) {
        case 'win': next += ctx.positionScoring && pos === 1 ? 1 : 0; break
        case 'podium': next += ctx.positionScoring && pos <= 3 ? 1 : 0; break
        case 'drift': next += result.driftScore; break
        case 'laps': next += ctx.laps; break
        case 'topSpeed': next = Math.max(next, ctx.topSpeedKmh); break
        case 'track': next += ctx.trackId === c.trackId ? 1 : 0; break
        case 'car': next += ctx.carId === c.carId ? 1 : 0; break
        case 'clean': next += ctx.damage < 0.15 ? 1 : 0; break
        case 'overtakes': next += ctx.overtakes; break
        case 'wet': next += ctx.wet ? 1 : 0; break
      }
      p.challenges.progress[c.id] = next
      if (next >= c.target) {
        p.challenges.completed.push(c.id)
        p.credits += c.reward
        p.xp += c.xp
        completed.push(c)
      }
    }
  })
  for (const c of completed) bus.emit('challenge:complete', { id: c.id, title: c.title, reward: c.reward })
  return completed
}
