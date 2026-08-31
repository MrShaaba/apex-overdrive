/**
 * UI-facing state. The engine writes here (HUD at ~20 Hz, screen changes,
 * results); React screens subscribe through `useGameStore`.
 */

import { useSyncExternalStore } from 'react'
import { Store } from '../core/Store'
import type { RaceResultSummary } from '../core/EventBus'
import type { RaceConfig } from '../gameplay/GameModes'
import type { RewardBreakdown } from '../gameplay/Progression'
import type { SeriesState } from '../gameplay/RaceManager'
import type { CameraMode } from '../core/Settings'
import type { AchievementDef } from '../gameplay/Achievements'
import type { Challenge } from '../gameplay/Challenges'

export type Screen = 'boot' | 'menu' | 'career' | 'garage' | 'setup' | 'rankings' | 'gallery' | 'options' | 'stats' | 'loading' | 'race' | 'results' | 'multiplayer'

export interface HudMessage {
  id: number
  text: string
  kind: 'info' | 'warn' | 'good' | 'bad'
  ttl: number
}

export interface HudStanding {
  id: number
  name: string
  position: number
  gap: number
  isPlayer: boolean
  carId: string
  finished: boolean
  eliminated: boolean
  color: string
  lap: number
}

export interface MinimapCar {
  x: number
  z: number
  yaw: number
  isPlayer: boolean
  color: string
}

export interface HudState {
  speedKmh: number
  rpm: number
  redline: number
  gear: number
  position: number
  total: number
  lap: number
  totalLaps: number
  lapTime: number
  bestLap: number
  lastLap: number
  raceTime: number
  nitro: number
  boostActive: boolean
  ersHarvest: boolean
  fuel: number
  damage: number
  turbo: number
  drifting: boolean
  driftCurrent: number
  driftMultiplier: number
  driftBanked: number
  countdown: number
  phase: string
  wrongWay: boolean
  standings: HudStanding[]
  minimap: MinimapCar[]
  eliminationTimer: number
  sectorTimes: number[]
  weather: string
  hour: number
  fps: number
  inPit: boolean
  cameraMode: CameraMode
  isNight: boolean
  wetness: number
  gLat: number
  gLong: number
  ghostDelta: number | null
  topSpeed: number
  mode: string
  seriesRound: string
}

export interface UIState {
  screen: Screen
  previousScreen: Screen
  booted: boolean
  bootError: string | null
  loading: { progress: number; label: string }
  profileVersion: number
  hud: HudState
  hudVisible: boolean
  messages: HudMessage[]
  paused: boolean
  raceConfig: RaceConfig | null
  results: RaceResultSummary | null
  rewards: RewardBreakdown | null
  resultStars: number
  series: SeriesState | null
  unlockedAchievements: AchievementDef[]
  completedChallenges: Challenge[]
  replay: { active: boolean; playing: boolean; time: number; duration: number; speed: number }
  photo: { active: boolean; lastCapture: string | null }
  toasts: { id: number; text: string; icon?: string }[]
  showcaseCar: string
  quality: { preset: string; scale: number }
  audioUnlocked: boolean
  gamepad: boolean
}

export const initialHud = (): HudState => ({
  speedKmh: 0,
  rpm: 0,
  redline: 8000,
  gear: 1,
  position: 1,
  total: 1,
  lap: 0,
  totalLaps: 3,
  lapTime: 0,
  bestLap: Infinity,
  lastLap: 0,
  raceTime: 0,
  nitro: 1,
  boostActive: false,
  ersHarvest: false,
  fuel: 1,
  damage: 0,
  turbo: 0,
  drifting: false,
  driftCurrent: 0,
  driftMultiplier: 1,
  driftBanked: 0,
  countdown: 0,
  phase: 'grid',
  wrongWay: false,
  standings: [],
  minimap: [],
  eliminationTimer: 0,
  sectorTimes: [],
  weather: 'clear',
  hour: 12,
  fps: 60,
  inPit: false,
  cameraMode: 'chase',
  isNight: false,
  wetness: 0,
  gLat: 0,
  gLong: 0,
  ghostDelta: null,
  topSpeed: 0,
  mode: 'quick',
  seriesRound: '',
})

export const gameStore = new Store<UIState>({
  screen: 'boot',
  previousScreen: 'boot',
  booted: false,
  bootError: null,
  loading: { progress: 0, label: 'Initialising' },
  profileVersion: 0,
  hud: initialHud(),
  hudVisible: true,
  messages: [],
  paused: false,
  raceConfig: null,
  results: null,
  rewards: null,
  resultStars: 0,
  series: null,
  unlockedAchievements: [],
  completedChallenges: [],
  replay: { active: false, playing: false, time: 0, duration: 0, speed: 1 },
  photo: { active: false, lastCapture: null },
  toasts: [],
  showcaseCar: 'v8-roadster',
  quality: { preset: 'auto', scale: 1 },
  audioUnlocked: false,
  gamepad: false,
})

export function useGameStore<T>(selector: (s: UIState) => T): T {
  return useSyncExternalStore(
    (cb) => gameStore.subscribe(cb),
    () => selector(gameStore.get()),
    () => selector(gameStore.get()),
  )
}

export function navigate(screen: Screen): void {
  const prev = gameStore.get().screen
  if (prev === screen) return
  gameStore.set({ screen, previousScreen: prev })
}

let toastId = 0
export function pushToast(text: string, icon?: string): void {
  const id = ++toastId
  gameStore.set((s) => ({ toasts: [...s.toasts.slice(-4), { id, text, icon }] }))
  window.setTimeout(() => gameStore.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200)
}

export function bumpProfile(): void {
  gameStore.set((s) => ({ profileVersion: s.profileVersion + 1 }))
}
