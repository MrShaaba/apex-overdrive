/**
 * AI driver roster. Each rival has a competency tier and a personality that
 * shapes overtaking appetite, defensive behaviour and error rate.
 */

import { createRng } from '../core/MathUtils'

export type DriverTier = 'rookie' | 'amateur' | 'pro' | 'elite' | 'legend'

export interface DriverProfile {
  id: string
  name: string
  nationality: string
  tier: DriverTier
  /** 0..1 raw pace (corner speed, braking points). */
  skill: number
  /** 0..1 willingness to dive for gaps and run close. */
  aggression: number
  /** 0..1 — higher = fewer mistakes. */
  consistency: number
  /** 0..1 tendency to block a car behind. */
  defending: number
  /** Preferred car class (used for car assignment). */
  favouriteCar: string
  color: string
}

export const TIER_LABEL: Record<DriverTier, string> = { rookie: 'Rookie', amateur: 'Amateur', pro: 'Pro', elite: 'Elite', legend: 'Legend' }

const TIER_SKILL: Record<DriverTier, [number, number]> = {
  rookie: [0.45, 0.6],
  amateur: [0.6, 0.72],
  pro: [0.72, 0.84],
  elite: [0.84, 0.93],
  legend: [0.93, 1.0],
}

const ROSTER: Omit<DriverProfile, 'skill'>[] = [
  { id: 'kai-moreno', name: 'Kai Moreno', nationality: 'ES', tier: 'legend', aggression: 0.7, consistency: 0.95, defending: 0.8, favouriteCar: 'modern-supercar', color: '#ff6a00' },
  { id: 'ines-varga', name: 'Inés Varga', nationality: 'HU', tier: 'legend', aggression: 0.55, consistency: 0.97, defending: 0.7, favouriteCar: 'endurance-prototype', color: '#12b3a6' },
  { id: 'dmitri-volk', name: 'Dmitri Volk', nationality: 'RU', tier: 'elite', aggression: 0.9, consistency: 0.8, defending: 0.9, favouriteCar: 'grand-tourer', color: '#0f4d2e' },
  { id: 'aiko-tanaka', name: 'Aiko Tanaka', nationality: 'JP', tier: 'elite', aggression: 0.6, consistency: 0.9, defending: 0.6, favouriteCar: 'drift-build', color: '#7b3cff' },
  { id: 'marcus-hale', name: 'Marcus Hale', nationality: 'GB', tier: 'elite', aggression: 0.5, consistency: 0.92, defending: 0.75, favouriteCar: 'track-special', color: '#ffd60a' },
  { id: 'lena-okafor', name: 'Lena Okafor', nationality: 'NG', tier: 'pro', aggression: 0.75, consistency: 0.82, defending: 0.7, favouriteCar: 'performance-ev', color: '#f4f4f0' },
  { id: 'rafael-costa', name: 'Rafael Costa', nationality: 'BR', tier: 'pro', aggression: 0.85, consistency: 0.7, defending: 0.85, favouriteCar: 'v8-roadster', color: '#d0102a' },
  { id: 'freya-lund', name: 'Freya Lund', nationality: 'SE', tier: 'pro', aggression: 0.45, consistency: 0.9, defending: 0.5, favouriteCar: 'rally-hatch', color: '#3d8bff' },
  { id: 'tomasz-nowak', name: 'Tomasz Nowak', nationality: 'PL', tier: 'pro', aggression: 0.65, consistency: 0.78, defending: 0.65, favouriteCar: 'grand-tourer', color: '#1a2140' },
  { id: 'sofia-ricci', name: 'Sofia Ricci', nationality: 'IT', tier: 'pro', aggression: 0.7, consistency: 0.84, defending: 0.6, favouriteCar: 'vintage-coupe', color: '#b1001a' },
  { id: 'jonah-blake', name: 'Jonah Blake', nationality: 'US', tier: 'amateur', aggression: 0.8, consistency: 0.62, defending: 0.7, favouriteCar: 'v8-roadster', color: '#4a4f57' },
  { id: 'mei-lin', name: 'Mei Lin', nationality: 'CN', tier: 'amateur', aggression: 0.4, consistency: 0.8, defending: 0.4, favouriteCar: 'performance-ev', color: '#5af5e0' },
  { id: 'omar-haddad', name: 'Omar Haddad', nationality: 'MA', tier: 'amateur', aggression: 0.6, consistency: 0.68, defending: 0.55, favouriteCar: 'rally-hatch', color: '#c8b27a' },
  { id: 'clara-weiss', name: 'Clara Weiss', nationality: 'DE', tier: 'amateur', aggression: 0.5, consistency: 0.75, defending: 0.5, favouriteCar: 'drift-build', color: '#ff2d95' },
  { id: 'luca-bianchi', name: 'Luca Bianchi', nationality: 'IT', tier: 'amateur', aggression: 0.7, consistency: 0.65, defending: 0.6, favouriteCar: 'vintage-coupe', color: '#1fbf4a' },
  { id: 'nia-thompson', name: 'Nia Thompson', nationality: 'JM', tier: 'rookie', aggression: 0.55, consistency: 0.55, defending: 0.35, favouriteCar: 'v8-roadster', color: '#ff7a18' },
  { id: 'ben-carter', name: 'Ben Carter', nationality: 'AU', tier: 'rookie', aggression: 0.9, consistency: 0.45, defending: 0.6, favouriteCar: 'rally-hatch', color: '#0c0d10' },
  { id: 'yuki-sato', name: 'Yuki Sato', nationality: 'JP', tier: 'rookie', aggression: 0.35, consistency: 0.7, defending: 0.3, favouriteCar: 'drift-build', color: '#7ef0ff' },
  { id: 'pedro-alvarez', name: 'Pedro Álvarez', nationality: 'MX', tier: 'rookie', aggression: 0.6, consistency: 0.5, defending: 0.45, favouriteCar: 'vintage-coupe', color: '#ffb347' },
  { id: 'hanna-berg', name: 'Hanna Berg', nationality: 'NO', tier: 'rookie', aggression: 0.45, consistency: 0.6, defending: 0.4, favouriteCar: 'performance-ev', color: '#e8eef4' },
  { id: 'sam-oduya', name: 'Sam Oduya', nationality: 'KE', tier: 'pro', aggression: 0.6, consistency: 0.85, defending: 0.7, favouriteCar: 'track-special', color: '#9b5a34' },
  { id: 'elena-petrova', name: 'Elena Petrova', nationality: 'BG', tier: 'elite', aggression: 0.8, consistency: 0.86, defending: 0.85, favouriteCar: 'modern-supercar', color: '#2a1b4d' },
  { id: 'theo-marchand', name: 'Théo Marchand', nationality: 'FR', tier: 'amateur', aggression: 0.55, consistency: 0.7, defending: 0.55, favouriteCar: 'grand-tourer', color: '#56813c' },
  { id: 'zara-khan', name: 'Zara Khan', nationality: 'PK', tier: 'rookie', aggression: 0.5, consistency: 0.58, defending: 0.4, favouriteCar: 'rally-hatch', color: '#ffd6e0' },
]

export function allDrivers(): DriverProfile[] {
  return ROSTER.map((d) => {
    const [lo, hi] = TIER_SKILL[d.tier]
    const rng = createRng(d.id.length * 7919 + d.name.charCodeAt(0))
    return { ...d, skill: lo + (hi - lo) * rng() }
  })
}

export type FieldMix = 'rookie' | 'amateur' | 'pro' | 'elite' | 'legend' | 'mixed'

/** Pick `count` rivals, biased by the requested tier mix. */
export function generateField(count: number, mix: FieldMix, seed: number): DriverProfile[] {
  const rng = createRng(seed)
  const all = allDrivers()
  const tierWeight = (t: DriverTier): number => {
    if (mix === 'mixed') return 1
    const order: DriverTier[] = ['rookie', 'amateur', 'pro', 'elite', 'legend']
    const d = Math.abs(order.indexOf(t) - order.indexOf(mix))
    return d === 0 ? 5 : d === 1 ? 2 : 0.3
  }
  const pool = all.map((d) => ({ d, w: tierWeight(d.tier) * (0.5 + rng()) })).sort((a, b) => b.w - a.w)
  return pool.slice(0, Math.min(count, pool.length)).map((p) => p.d)
}
