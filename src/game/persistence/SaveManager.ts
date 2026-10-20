/**
 * Versioned save system. Owns the player profile document, applies schema
 * migrations, debounces writes, and exposes typed accessors. Everything the
 * player earns (credits, XP, cars, records, achievements, settings) is stored
 * in one `PlayerProfile` object so a future cloud sync only needs to move one
 * document.
 */

import { bus } from '../core/EventBus'
import { TRACK_CATALOG } from '../tracks/TrackCatalog'
import { resolveVehicleId } from '../vehicles/VehicleCatalog'
import { Logger } from '../core/Logger'
import { defaultSettings, type Settings } from '../core/Settings'
import { LocalStorageAdapter, type StorageAdapter } from './StorageAdapter'
import type { VehicleCustomization, VehicleUpgrades } from '../vehicles/VehicleSpec'

const log = Logger.scope('Save')

export const SAVE_VERSION = 3
const PROFILE_KEY = 'profile'

export interface LapRecord {
  time: number
  carId: string
  date: number
  playerName: string
}

export interface LeaderboardEntry {
  name: string
  time: number
  carId: string
  date: number
  isPlayer: boolean
}

export interface PlayerStats {
  racesEntered: number
  racesWon: number
  podiums: number
  lapsCompleted: number
  distanceKm: number
  topSpeedKmh: number
  driftPointsTotal: number
  crashes: number
  overtakes: number
  timePlayedSec: number
  creditsEarned: number
  bestFinishByMode: Record<string, number>
}

export interface CarSaveState {
  customization: VehicleCustomization
  upgrades: VehicleUpgrades
  damage: number
  odometerKm: number
}

export interface PlayerProfile {
  version: number
  createdAt: number
  updatedAt: number
  playerName: string
  credits: number
  xp: number
  level: number
  ownedCars: string[]
  selectedCar: string
  cars: Record<string, CarSaveState>
  unlockedTracks: string[]
  career: {
    chapter: number
    completedEvents: string[]
    eventStars: Record<string, number>
  }
  stats: PlayerStats
  achievements: string[]
  challenges: {
    period: string
    completed: string[]
    progress: Record<string, number>
  }
  sponsors: {
    active: string[]
    completed: string[]
    progress: Record<string, number>
  }
  records: Record<string, LapRecord>
  leaderboards: Record<string, LeaderboardEntry[]>
  ghosts: Record<string, GhostData>
  photos: string[]
  settings: Settings
  rating: { elo: number; wins: number; losses: number }
}

export interface GhostData {
  carId: string
  lapTime: number
  sampleRate: number
  /** Flat array of [x,y,z,qx,qy,qz,qw] per sample. */
  samples: number[]
}

export function createDefaultProfile(): PlayerProfile {
  return {
    version: SAVE_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    playerName: 'Driver',
    credits: 25000,
    xp: 0,
    level: 1,
    ownedCars: ['mercedes-sls'],
    selectedCar: 'mercedes-sls',
    cars: {},
    unlockedTracks: TRACK_CATALOG.filter((track) => track.unlockLevel <= 1).map((track) => track.id),
    career: { chapter: 0, completedEvents: [], eventStars: {} },
    stats: {
      racesEntered: 0,
      racesWon: 0,
      podiums: 0,
      lapsCompleted: 0,
      distanceKm: 0,
      topSpeedKmh: 0,
      driftPointsTotal: 0,
      crashes: 0,
      overtakes: 0,
      timePlayedSec: 0,
      creditsEarned: 0,
      bestFinishByMode: {},
    },
    achievements: [],
    challenges: { period: '', completed: [], progress: {} },
    sponsors: { active: [], completed: [], progress: {} },
    records: {},
    leaderboards: {},
    ghosts: {},
    photos: [],
    settings: defaultSettings(),
    rating: { elo: 1200, wins: 0, losses: 0 },
  }
}

type Migration = (profile: PlayerProfile) => PlayerProfile

/** Ordered migrations keyed by the version they upgrade FROM. */
const MIGRATIONS: Record<number, Migration> = {
  1: (p) => ({ ...p, ghosts: p.ghosts ?? {}, rating: p.rating ?? { elo: 1200, wins: 0, losses: 0 }, version: 2 }),
  2: (p) => ({ ...p, photos: p.photos ?? [], version: 3 }),
}

export class SaveManager {
  private profile: PlayerProfile = createDefaultProfile()
  private adapter: StorageAdapter
  private writeTimer: number | null = null
  private dirty = false
  private loaded = false

  constructor(adapter?: StorageAdapter) {
    this.adapter = adapter ?? new LocalStorageAdapter()
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.flushSync())
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushSync()
      })
    }
  }

  /** Allows swapping to cloud storage after sign-in without touching call sites. */
  setAdapter(adapter: StorageAdapter): void {
    this.adapter = adapter
    this.dirty = true
    this.scheduleWrite()
  }

  async load(): Promise<PlayerProfile> {
    try {
      const stored = await this.adapter.read<PlayerProfile>(PROFILE_KEY)
      if (stored) {
        this.profile = this.migrate(stored)
        // Deep-merge settings so new settings keys get sane defaults.
        const defaults = defaultSettings()
        this.profile.settings = {
          graphics: { ...defaults.graphics, ...this.profile.settings?.graphics },
          audio: { ...defaults.audio, ...this.profile.settings?.audio },
          controls: { ...defaults.controls, ...this.profile.settings?.controls },
          gameplay: { ...defaults.gameplay, ...this.profile.settings?.gameplay },
        }
        // Retired procedural cars map onto their licensed replacements.
        const prof = this.profile
        prof.ownedCars = [...new Set(prof.ownedCars.map(resolveVehicleId))]
        prof.selectedCar = resolveVehicleId(prof.selectedCar)
        for (const [id, state] of Object.entries(prof.cars)) {
          const next = resolveVehicleId(id)
          if (next !== id) {
            if (!prof.cars[next]) prof.cars[next] = state
            delete prof.cars[id]
          }
        }
        // Circuits added after this profile was created unlock straight away at their level.
        for (const t of TRACK_CATALOG) if (t.unlockLevel <= this.profile.level && !this.profile.unlockedTracks.includes(t.id)) this.profile.unlockedTracks.push(t.id)
        log.info(`Profile loaded (v${this.profile.version}, ${this.profile.ownedCars.length} cars)`)
      } else {
        log.info('No profile found — creating a new one')
        this.profile = createDefaultProfile()
        this.dirty = true
      }
    } catch (err) {
      log.error('Failed to load profile, starting fresh', err)
      this.profile = createDefaultProfile()
    }
    this.loaded = true
    return this.profile
  }

  private migrate(p: PlayerProfile): PlayerProfile {
    let current = p
    let guard = 0
    while ((current.version ?? 1) < SAVE_VERSION && guard++ < 20) {
      const from = current.version ?? 1
      const m = MIGRATIONS[from]
      if (!m) {
        current = { ...current, version: from + 1 }
        continue
      }
      current = m(current)
      log.info(`Migrated save v${from} → v${current.version}`)
    }
    const defaults = defaultSettings()
    return {
      ...createDefaultProfile(), ...current, version: SAVE_VERSION,
      settings: {
        graphics: { ...defaults.graphics, ...current.settings?.graphics },
        audio: { ...defaults.audio, ...current.settings?.audio },
        controls: { ...defaults.controls, ...current.settings?.controls },
        gameplay: { ...defaults.gameplay, ...current.settings?.gameplay },
      },
    }
  }

  get(): PlayerProfile {
    // A catalog extension is immediately available to eligible old and new saves.
    // Preserve explicitly earned unlocks (career rewards), deriving level unlocks.
    const unlocked = new Set(this.profile.unlockedTracks)
    for (const track of TRACK_CATALOG) if (track.unlockLevel <= this.profile.level) unlocked.add(track.id)
    if (unlocked.size !== this.profile.unlockedTracks.length) this.profile.unlockedTracks = [...unlocked]
    return this.profile
  }

  isLoaded(): boolean {
    return this.loaded
  }

  /** Mutate the profile in place via `fn` and schedule a debounced write. */
  update(fn: (p: PlayerProfile) => void): PlayerProfile {
    fn(this.profile)
    this.profile.updatedAt = Date.now()
    this.dirty = true
    this.scheduleWrite()
    return this.profile
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== null) return
    this.writeTimer = window.setTimeout(() => {
      this.writeTimer = null
      void this.flush()
    }, 400)
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    try {
      await this.adapter.write(PROFILE_KEY, this.profile)
      bus.emit('save:written', { key: PROFILE_KEY })
    } catch (err) {
      this.dirty = true
      log.error('Write failed', err)
    }
  }

  /** Synchronous best-effort write used on page hide/unload. */
  private flushSync(): void {
    if (!this.dirty) return
    try {
      localStorage.setItem('apex-overdrive:' + PROFILE_KEY, JSON.stringify(this.profile))
      this.dirty = false
    } catch {
      /* ignore */
    }
  }

  async reset(): Promise<void> {
    this.profile = createDefaultProfile()
    this.dirty = true
    await this.adapter.remove(PROFILE_KEY)
    await this.flush()
  }

  exportJson(): string {
    return JSON.stringify(this.profile, null, 2)
  }

  async importJson(json: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(json) as PlayerProfile
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.ownedCars) ||
        !parsed.ownedCars.every((id) => typeof id === 'string') ||
        (parsed.unlockedTracks !== undefined && !Array.isArray(parsed.unlockedTracks)) ||
        (parsed.level !== undefined && (!Number.isFinite(parsed.level) || parsed.level < 1))) return false
      this.profile = this.migrate(parsed)
      this.get()
      this.dirty = true
      await this.flush()
      return true
    } catch {
      return false
    }
  }

  async storageUsage(): Promise<{ bytes: number; adapter: string }> {
    return { bytes: await this.adapter.usage(), adapter: this.adapter.name }
  }
}

export const saveManager = new SaveManager()
