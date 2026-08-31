/**
 * Progression economy: race payouts, XP → driver rank, car unlocks, sponsor
 * contracts and stat tracking. Pure functions where possible so the results
 * screen can preview rewards before they are committed to the profile.
 */

import { bus, type RaceResultSummary } from '../core/EventBus'
import { saveManager, type PlayerProfile } from '../persistence/SaveManager'
import { VEHICLE_CATALOG } from '../vehicles/VehicleCatalog'
import { TRACK_CATALOG } from '../tracks/TrackCatalog'
import { GAME_MODES, type RaceConfig } from './GameModes'
import { defaultCustomization, defaultUpgrades } from '../vehicles/VehicleSpec'
import { getVehicleSpec } from '../vehicles/VehicleCatalog'

export const RANKS: { level: number; title: string }[] = [
  { level: 1, title: 'Rookie' },
  { level: 3, title: 'Club Racer' },
  { level: 5, title: 'Amateur' },
  { level: 8, title: 'Semi-Pro' },
  { level: 11, title: 'Professional' },
  { level: 14, title: 'Works Driver' },
  { level: 17, title: 'Elite' },
  { level: 20, title: 'Champion' },
  { level: 24, title: 'Legend' },
  { level: 30, title: 'Apex' },
]

export function xpForLevel(level: number): number {
  return Math.round(600 * Math.pow(level - 1, 1.55) + 400 * (level - 1))
}

export function levelFromXp(xp: number): number {
  let level = 1
  while (xpForLevel(level + 1) <= xp && level < 60) level++
  return level
}

export function rankTitle(level: number): string {
  let title = RANKS[0].title
  for (const r of RANKS) if (level >= r.level) title = r.title
  return title
}

export interface SponsorContract {
  id: string
  brand: string
  tagline: string
  color: string
  requirementLevel: number
  objective: { kind: 'wins' | 'podiums' | 'races' | 'drift' | 'laps' | 'topSpeed' | 'overtakes' | 'wet-wins'; target: number; label: string }
  reward: number
  perRaceBonus: number
}

export const SPONSORS: SponsorContract[] = [
  { id: 'volt', brand: 'Volt Energy', tagline: 'Charge harder.', color: '#7ef0ff', requirementLevel: 1, objective: { kind: 'races', target: 3, label: 'Enter 3 races' }, reward: 8000, perRaceBonus: 400 },
  { id: 'grip', brand: 'GripWorks Tyres', tagline: 'Stick with us.', color: '#ffd60a', requirementLevel: 2, objective: { kind: 'podiums', target: 3, label: 'Finish on the podium 3 times' }, reward: 15000, perRaceBonus: 700 },
  { id: 'nitrous', brand: 'N2O Labs', tagline: 'Boost responsibly.', color: '#ff2d95', requirementLevel: 4, objective: { kind: 'drift', target: 40000, label: 'Bank 40,000 drift points' }, reward: 20000, perRaceBonus: 900 },
  { id: 'apexoil', brand: 'Apex Lubricants', tagline: 'Smooth is fast.', color: '#ff6a00', requirementLevel: 6, objective: { kind: 'laps', target: 60, label: 'Complete 60 laps' }, reward: 25000, perRaceBonus: 1100 },
  { id: 'rainx', brand: 'Monsoon Wipers', tagline: 'See through the storm.', color: '#3d8bff', requirementLevel: 8, objective: { kind: 'wet-wins', target: 2, label: 'Win 2 races in the rain' }, reward: 30000, perRaceBonus: 1300 },
  { id: 'velocity', brand: 'Velocity Watches', tagline: 'Every tenth counts.', color: '#c8b27a', requirementLevel: 10, objective: { kind: 'topSpeed', target: 320, label: 'Reach 320 km/h' }, reward: 35000, perRaceBonus: 1500 },
  { id: 'overtake', brand: 'Slipstream Media', tagline: 'Make the highlight reel.', color: '#7b3cff', requirementLevel: 12, objective: { kind: 'overtakes', target: 100, label: 'Complete 100 overtakes' }, reward: 45000, perRaceBonus: 1800 },
  { id: 'crown', brand: 'Crown Motorsport', tagline: 'Winning is the brief.', color: '#12b3a6', requirementLevel: 15, objective: { kind: 'wins', target: 15, label: 'Win 15 races' }, reward: 80000, perRaceBonus: 2500 },
]

export interface RewardBreakdown {
  positionCredits: number
  lapCredits: number
  driftCredits: number
  sponsorCredits: number
  cleanBonus: number
  difficultyBonus: number
  totalCredits: number
  xp: number
  repairCost: number
  levelBefore: number
  levelAfter: number
  unlocks: { kind: 'car' | 'track' | 'sponsor'; id: string; title: string }[]
  sponsorsCompleted: SponsorContract[]
}

const POSITION_PAYOUT = [12000, 8500, 6500, 5000, 4000, 3200, 2600, 2100, 1700, 1400, 1200, 1000, 900, 800]

export function previewRewards(result: RaceResultSummary, config: RaceConfig, profile: PlayerProfile, wet: boolean): RewardBreakdown {
  const mode = GAME_MODES[config.mode]
  const diffMult = config.difficulty === 'legend' ? 1.5 : config.difficulty === 'pro' ? 1.25 : config.difficulty === 'amateur' ? 1 : config.difficulty === 'rookie' ? 0.8 : 1.1
  const fieldMult = 0.6 + Math.min(13, config.aiCount) * 0.04
  const pos = Math.max(1, result.playerPosition)
  const positionCredits = mode.scoring === 'position' ? Math.round((POSITION_PAYOUT[pos - 1] ?? 500) * mode.payoutMultiplier * fieldMult) : mode.scoring === 'time' ? 1500 : 0
  const lapCredits = Math.round(Math.max(1, config.laps) * 350 * mode.payoutMultiplier)
  const driftCredits = Math.round(result.driftScore * (mode.scoring === 'drift' ? 0.25 : 0.05))
  const cleanBonus = result.entries.find((e) => e.isPlayer)?.damage ?? 1
  const cleanCredits = cleanBonus < 0.12 ? 1500 : 0
  const activeSponsors = SPONSORS.filter((s) => profile.sponsors.active.includes(s.id))
  const sponsorCredits = activeSponsors.reduce((sum, s) => sum + s.perRaceBonus, 0)
  const difficultyBonus = Math.round((positionCredits + lapCredits) * (diffMult - 1))
  const total = Math.max(0, Math.round((positionCredits + lapCredits + driftCredits + cleanCredits + sponsorCredits + difficultyBonus) * (result.isPersonalBest ? 1.1 : 1)))
  const repairCost = Math.round((result.entries.find((e) => e.isPlayer)?.damage ?? 0) * getVehicleSpec(config.carId).price * 0.03)
  const xp = Math.round((250 + Math.max(0, 14 - pos) * 60 + config.laps * 40 + result.driftScore * 0.01) * mode.xpMultiplier * diffMult)
  const levelBefore = profile.level
  const levelAfter = levelFromXp(profile.xp + xp)
  const unlocks: RewardBreakdown['unlocks'] = []
  for (const car of VEHICLE_CATALOG) if (car.unlockLevel > levelBefore && car.unlockLevel <= levelAfter) unlocks.push({ kind: 'car', id: car.id, title: `${car.brand} ${car.name} available in the dealership` })
  for (const t of TRACK_CATALOG) if (t.unlockLevel > levelBefore && t.unlockLevel <= levelAfter) unlocks.push({ kind: 'track', id: t.id, title: `${t.name} unlocked` })
  for (const s of SPONSORS) if (s.requirementLevel > levelBefore && s.requirementLevel <= levelAfter) unlocks.push({ kind: 'sponsor', id: s.id, title: `${s.brand} sponsorship offer` })
  const sponsorsCompleted: SponsorContract[] = []
  void wet
  return { positionCredits, lapCredits, driftCredits, sponsorCredits, cleanBonus: cleanCredits, difficultyBonus, totalCredits: total, xp, repairCost, levelBefore, levelAfter, unlocks, sponsorsCompleted }
}

/** Commit a finished race to the profile. */
export function applyRaceRewards(result: RaceResultSummary, config: RaceConfig, wet: boolean, topSpeedKmh: number, distanceKm: number, overtakes: number, crashes: number, lapsDone: number): RewardBreakdown {
  const profile = saveManager.get()
  const breakdown = previewRewards(result, config, profile, wet)
  const pos = Math.max(1, result.playerPosition)
  const positionScoring = GAME_MODES[config.mode].scoring === 'position'
  saveManager.update((p) => {
    p.credits += breakdown.totalCredits - breakdown.repairCost
    p.xp += breakdown.xp
    p.level = levelFromXp(p.xp)
    const st = p.stats
    st.racesEntered++
    if (positionScoring && pos === 1) st.racesWon++
    if (positionScoring && pos <= 3) st.podiums++
    st.lapsCompleted += lapsDone
    st.distanceKm += distanceKm
    st.topSpeedKmh = Math.max(st.topSpeedKmh, topSpeedKmh)
    st.driftPointsTotal += result.driftScore
    st.crashes += crashes
    st.overtakes += overtakes
    st.creditsEarned += breakdown.totalCredits
    const prev = st.bestFinishByMode[config.mode] ?? 99
    if (pos < prev) st.bestFinishByMode[config.mode] = pos
    for (const t of TRACK_CATALOG) if (t.unlockLevel <= p.level && !p.unlockedTracks.includes(t.id)) p.unlockedTracks.push(t.id)
    // Sponsor objectives.
    for (const s of SPONSORS) {
      if (!p.sponsors.active.includes(s.id) || p.sponsors.completed.includes(s.id)) continue
      const o = s.objective
      const inc = o.kind === 'wins' ? (positionScoring && pos === 1 ? 1 : 0) : o.kind === 'podiums' ? (positionScoring && pos <= 3 ? 1 : 0) : o.kind === 'races' ? 1 : o.kind === 'drift' ? result.driftScore : o.kind === 'laps' ? lapsDone : o.kind === 'overtakes' ? overtakes : o.kind === 'wet-wins' ? (wet && positionScoring && pos === 1 ? 1 : 0) : 0
      if (o.kind === 'topSpeed') p.sponsors.progress[s.id] = Math.max(p.sponsors.progress[s.id] ?? 0, topSpeedKmh)
      else p.sponsors.progress[s.id] = (p.sponsors.progress[s.id] ?? 0) + inc
      if ((p.sponsors.progress[s.id] ?? 0) >= o.target) {
        p.sponsors.completed.push(s.id)
        p.sponsors.active = p.sponsors.active.filter((id) => id !== s.id)
        p.credits += s.reward
        breakdown.sponsorsCompleted.push(s)
      }
    }
    // Car damage persists on the car until repaired (garage repair costs credits).
    const carState = p.cars[config.carId]
    const dmg = result.entries.find((e) => e.isPlayer)?.damage ?? 0
    if (carState) {
      carState.damage = Math.min(1, dmg)
      carState.odometerKm += distanceKm
    }
  })
  if (breakdown.levelAfter > breakdown.levelBefore) bus.emit('progress:levelup', { level: breakdown.levelAfter, rank: rankTitle(breakdown.levelAfter) })
  for (const u of breakdown.unlocks) bus.emit('progress:unlock', { kind: u.kind, id: u.id, title: u.title })
  for (const s of breakdown.sponsorsCompleted) bus.emit('progress:unlock', { kind: 'sponsor', id: s.id, title: `${s.brand} contract complete: +${s.reward} CR` })
  bus.emit('progress:credits', { delta: breakdown.totalCredits - breakdown.repairCost, total: saveManager.get().credits, reason: 'race' })
  return breakdown
}

export function ensureCarState(carId: string): void {
  saveManager.update((p) => {
    if (!p.cars[carId]) {
      const spec = getVehicleSpec(carId)
      p.cars[carId] = { customization: defaultCustomization(spec), upgrades: defaultUpgrades(), damage: 0, odometerKm: 0 }
    }
  })
}

export function purchaseCar(carId: string): { ok: boolean; reason?: string } {
  const p = saveManager.get()
  const spec = getVehicleSpec(carId)
  if (p.ownedCars.includes(carId)) return { ok: false, reason: 'Already owned' }
  if (p.level < spec.unlockLevel) return { ok: false, reason: `Requires driver level ${spec.unlockLevel}` }
  if (p.credits < spec.price) return { ok: false, reason: 'Insufficient credits' }
  saveManager.update((pp) => {
    pp.credits -= spec.price
    pp.ownedCars.push(carId)
    pp.selectedCar = carId
  })
  ensureCarState(carId)
  bus.emit('progress:unlock', { kind: 'car', id: carId, title: `${spec.brand} ${spec.name} added to your garage` })
  bus.emit('progress:credits', { delta: -spec.price, total: saveManager.get().credits, reason: 'purchase' })
  return { ok: true }
}

export function repairCar(carId: string): { ok: boolean; cost: number } {
  const p = saveManager.get()
  const state = p.cars[carId]
  if (!state || state.damage <= 0) return { ok: true, cost: 0 }
  const cost = Math.round(state.damage * getVehicleSpec(carId).price * 0.03 + 200)
  if (p.credits < cost) return { ok: false, cost }
  saveManager.update((pp) => {
    pp.credits -= cost
    pp.cars[carId].damage = 0
  })
  return { ok: true, cost }
}
