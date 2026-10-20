/**
 * Game mode definitions + the race configuration object that every screen
 * (race setup, career, challenges) produces and `RaceManager` consumes.
 */

import type { FieldMix } from '../ai/DriverProfiles'
import type { DifficultyLevel } from '../core/Settings'
import type { WeatherKind } from '../tracks/TrackCatalog'

export type GameModeId = 'career' | 'quick' | 'timetrial' | 'championship' | 'elimination' | 'drift' | 'sprint' | 'endurance' | 'knockout' | 'freeroam'

export interface GameModeDef {
  id: GameModeId
  title: string
  subtitle: string
  description: string
  icon: string
  defaultLaps: number | 'track'
  lapsSelectable: boolean
  aiDefault: number
  aiMax: number
  pointToPoint: boolean
  scoring: 'position' | 'time' | 'drift' | 'none'
  eliminationInterval: number
  payoutMultiplier: number
  xpMultiplier: number
  showInMenu: boolean
}

export const GAME_MODES: Record<GameModeId, GameModeDef> = {
  career: { id: 'career', title: 'Story', subtitle: 'Rise through the Apex League', description: 'Six chapters of scripted events with rivals, sponsors and unlocks.', icon: '🏆', defaultLaps: 'track', lapsSelectable: false, aiDefault: 9, aiMax: 13, pointToPoint: false, scoring: 'position', eliminationInterval: 0, payoutMultiplier: 1.4, xpMultiplier: 1.4, showInMenu: true },
  quick: { id: 'quick', title: 'Instant Race', subtitle: 'Pick a track, pick a car, go', description: 'A standard multi-car race with full options.', icon: '🏁', defaultLaps: 'track', lapsSelectable: true, aiDefault: 9, aiMax: 13, pointToPoint: false, scoring: 'position', eliminationInterval: 0, payoutMultiplier: 1, xpMultiplier: 1, showInMenu: true },
  timetrial: { id: 'timetrial', title: 'Solo Lap Challenge', subtitle: 'You, the clock and a ghost', description: 'Empty track. Beat your best lap; your ghost races alongside you.', icon: '⏱️', defaultLaps: 5, lapsSelectable: true, aiDefault: 0, aiMax: 0, pointToPoint: false, scoring: 'time', eliminationInterval: 0, payoutMultiplier: 0.5, xpMultiplier: 0.7, showInMenu: true },
  championship: { id: 'championship', title: 'Season Cup', subtitle: 'Four rounds, points decide', description: 'A four-track series. Points per round; most points lifts the cup.', icon: '👑', defaultLaps: 'track', lapsSelectable: true, aiDefault: 11, aiMax: 13, pointToPoint: false, scoring: 'position', eliminationInterval: 0, payoutMultiplier: 1.6, xpMultiplier: 1.5, showInMenu: true },
  elimination: { id: 'elimination', title: 'Last-Place-Out', subtitle: 'Every 20 seconds, someone goes', description: 'The car in last place is eliminated on a timer until one remains.', icon: '💀', defaultLaps: 20, lapsSelectable: false, aiDefault: 11, aiMax: 13, pointToPoint: false, scoring: 'position', eliminationInterval: 20, payoutMultiplier: 1.3, xpMultiplier: 1.2, showInMenu: true },
  drift: { id: 'drift', title: 'Drift Points', subtitle: 'Angle × speed × style', description: 'Score by holding slides. Chains multiply; collisions reset the chain.', icon: '🌀', defaultLaps: 2, lapsSelectable: true, aiDefault: 0, aiMax: 4, pointToPoint: false, scoring: 'drift', eliminationInterval: 0, payoutMultiplier: 1.1, xpMultiplier: 1, showInMenu: true },
  sprint: { id: 'sprint', title: 'Point-to-Point Dash', subtitle: 'One run, no second chances', description: 'A single flat-out sprint from start to finish.', icon: '⚡', defaultLaps: 1, lapsSelectable: false, aiDefault: 7, aiMax: 13, pointToPoint: true, scoring: 'position', eliminationInterval: 0, payoutMultiplier: 1.1, xpMultiplier: 1, showInMenu: true },
  endurance: { id: 'endurance', title: 'Multi-lap Event', subtitle: 'Fuel, tyres, damage — manage them', description: 'Long race with fuel consumption, wear and mandatory pit strategy.', icon: '🛠️', defaultLaps: 10, lapsSelectable: true, aiDefault: 11, aiMax: 13, pointToPoint: false, scoring: 'position', eliminationInterval: 0, payoutMultiplier: 2.0, xpMultiplier: 1.8, showInMenu: true },
  knockout: { id: 'knockout', title: 'Knockout Cup', subtitle: 'Three heats, half the field each time', description: 'Finish in the top half of each heat to progress to the final.', icon: '🥊', defaultLaps: 2, lapsSelectable: false, aiDefault: 11, aiMax: 13, pointToPoint: false, scoring: 'position', eliminationInterval: 0, payoutMultiplier: 1.5, xpMultiplier: 1.4, showInMenu: true },
  freeroam: { id: 'freeroam', title: 'Open Driving', subtitle: 'No timer, no rivals', description: 'Explore any circuit at your own pace. Great for tuning and photos.', icon: '🛣️', defaultLaps: 0, lapsSelectable: false, aiDefault: 0, aiMax: 6, pointToPoint: false, scoring: 'none', eliminationInterval: 0, payoutMultiplier: 0, xpMultiplier: 0.2, showInMenu: true },
}

export type SplitLayout = 'stack' | 'side'

export interface RaceConfig {
  mode: GameModeId
  trackId: string
  carId: string
  laps: number
  aiCount: number
  aiMix: FieldMix
  difficulty: DifficultyLevel
  weather: WeatherKind | 'random'
  hour: number | 'default'
  dynamicWeather: boolean
  /** Game hours per real minute (0 = frozen). */
  timeRate: number
  ghost: boolean
  eventId?: string
  seriesRound?: number
  seriesTotal?: number
  heat?: number
  seed: number
  playerGridSlot?: number
  /** Local players sharing the screen (1 or 2). */
  players?: 1 | 2
  /** Player 2's car (two-player only). */
  carId2?: string
  /** Split-screen layout for two players: stacked top/bottom or side by side. */
  splitLayout?: SplitLayout
}

export function defaultRaceConfig(partial: Partial<RaceConfig> = {}): RaceConfig {
  return {
    mode: 'quick',
    trackId: 'island-causeway',
    carId: 'mercedes-sls',
    laps: 3,
    aiCount: 9,
    aiMix: 'mixed',
    difficulty: 'adaptive',
    weather: 'clear',
    hour: 'default',
    dynamicWeather: true,
    timeRate: 0.25,
    ghost: true,
    seed: Math.floor(Math.random() * 1e9),
    ...partial,
  }
}

export const DIFFICULTY_SCALE: Record<DifficultyLevel, number> = { rookie: 0.72, amateur: 0.84, pro: 0.95, legend: 1.08, adaptive: 0.9 }
export const DIFFICULTY_LABEL: Record<DifficultyLevel, string> = { rookie: 'Rookie', amateur: 'Amateur', pro: 'Pro', legend: 'Legend', adaptive: 'Adaptive' }

/** Championship points per finishing position. */
export const SERIES_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1, 0, 0, 0, 0]
