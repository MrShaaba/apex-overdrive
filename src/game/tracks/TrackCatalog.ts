/**
 * The nine circuits. Control points are metres (X east, Y up, Z north). Every
 * feature is declared in normalised spline parameter space (0..1) so a layout
 * can be re-shaped without breaking its tunnels, bridges or crowd zones.
 */

import type { SurfaceType } from '../physics/Surfaces'

export type TrackTheme = 'island' | 'alpine' | 'badlands' | 'woodland' | 'metro' | 'glacier' | 'shipyard' | 'neon' | 'lakeside'
export type WeatherKind = 'clear' | 'cloudy' | 'overcast' | 'rain' | 'storm' | 'fog' | 'snow' | 'blizzard'
export type HazardKind = 'train' | 'crane' | 'rockfall' | 'gate' | 'ice' | 'bales' | 'avalanche' | 'carts' | 'truck' | 'fountain'

export type TrackFeature =
  | { type: 'tunnel'; from: number; to: number; style?: 'rock' | 'concrete' | 'ice' | 'neon' | 'steel' }
  | { type: 'bridge'; from: number; to: number; style?: 'concrete' | 'steel' | 'wood' | 'causeway' }
  | { type: 'shortcut'; points: [number, number, number][]; entry: number; exit: number; surface: SurfaceType; width?: number }
  | { type: 'crowd'; at: number; side: -1 | 1; length: number; grandstand?: boolean }
  | { type: 'hazard'; kind: HazardKind; at: number; period?: number; span?: number; side?: -1 | 1 }
  | { type: 'pit'; from: number; to: number; side: -1 | 1 }
  | { type: 'jump'; at: number }
  | { type: 'sector'; at: number }

export interface TrackEnvironment {
  terrain: 'hills' | 'mountain' | 'flat' | 'canyon' | 'island' | 'city' | 'valley'
  terrainAmplitude: number
  waterLevel: number | null
  snow: boolean
  defaultHour: number
  defaultWeather: WeatherKind
  weatherOptions: WeatherKind[]
  fogDensity: number
  skyTint: string
  groundColor: string
  roadColor: string
  hasStreetLights: boolean
  hasNeon: boolean
  treeDensity: number
  buildingDensity: number
}

export interface TrackDefinition {
  id: string
  name: string
  location: string
  description: string
  theme: TrackTheme
  points: [number, number, number][]
  closed: boolean
  width: number
  difficulty: 1 | 2 | 3 | 4 | 5
  unlockLevel: number
  defaultLaps: number
  environment: TrackEnvironment
  features: TrackFeature[]
  /** Approximate length in km (display only, real value comes from the spline). */
  lengthKm: number
  bestLapReference: number
}

const env = (o: Partial<TrackEnvironment>): TrackEnvironment => ({
  terrain: 'hills',
  terrainAmplitude: 18,
  waterLevel: null,
  snow: false,
  defaultHour: 14,
  defaultWeather: 'clear',
  weatherOptions: ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog'],
  fogDensity: 0.0025,
  skyTint: '#8fc5ff',
  groundColor: '#4d6a3a',
  roadColor: '#2e2f33',
  hasStreetLights: false,
  hasNeon: false,
  treeDensity: 1,
  buildingDensity: 0,
  ...o,
})

export const TRACK_CATALOG: TrackDefinition[] = [
  {
    id: 'island-causeway',
    name: 'Island Causeway',
    location: 'Isla Verde, Caribbean',
    description: 'Palm-lined coastal sweeps and a two-kilometre causeway over turquoise water. Fast, forgiving and beautiful — until the drawbridge gate swings.',
    theme: 'island',
    closed: true,
    width: 13,
    difficulty: 1,
    unlockLevel: 1,
    defaultLaps: 3,
    lengthKm: 4.6,
    bestLapReference: 112,
    environment: env({ terrain: 'island', terrainAmplitude: 14, waterLevel: 0.4, defaultHour: 15, skyTint: '#9fd8ff', groundColor: '#6d9c4a', treeDensity: 1.1, fogDensity: 0.0018, weatherOptions: ['clear', 'cloudy', 'rain', 'storm'] }),
    points: [
      [0, 6, 0], [140, 6, 40], [260, 8, 120], [330, 10, 260], [300, 9, 400], [180, 8, 470], [40, 8, 520], [-120, 8, 540], [-280, 8, 520], [-400, 9, 430],
      [-460, 12, 280], [-420, 16, 140], [-330, 20, 60], [-240, 18, -40], [-160, 14, -120], [-60, 9, -110],
    ],
    features: [
      { type: 'bridge', from: 0.28, to: 0.55, style: 'causeway' },
      { type: 'crowd', at: 0.02, side: 1, length: 90, grandstand: true },
      { type: 'crowd', at: 0.7, side: -1, length: 50 },
      { type: 'shortcut', points: [[-330, 20, 60], [-300, 17, -20], [-200, 13, -90], [-60, 9, -110]], entry: 0.75, exit: 0.97, surface: 'sand', width: 8 },
      { type: 'hazard', kind: 'gate', at: 0.42, period: 14, side: 1 },
      { type: 'pit', from: 0.9, to: 0.99, side: 1 },
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'lakeside-circuit',
    name: 'Lakeside Circuit',
    location: 'Lago Sereno, Northern Italy',
    description: 'A classic club circuit rolling around a mountain lake: a wooden bridge, a blind crest, and hay bales that do not always stay put.',
    theme: 'lakeside',
    closed: true,
    width: 12,
    difficulty: 2,
    unlockLevel: 1,
    defaultLaps: 4,
    lengthKm: 3.4,
    bestLapReference: 88,
    environment: env({ terrain: 'valley', terrainAmplitude: 22, waterLevel: 1.0, defaultHour: 10, skyTint: '#a8d4ff', groundColor: '#56813c', treeDensity: 1.2, fogDensity: 0.0022 }),
    points: [
      [0, 5, 0], [120, 6, 30], [220, 10, 110], [250, 14, 220], [180, 16, 310], [60, 15, 330], [-60, 12, 280], [-150, 10, 330], [-260, 9, 300], [-320, 8, 190],
      [-300, 7, 80], [-220, 9, 10], [-120, 6, -40],
    ],
    features: [
      { type: 'bridge', from: 0.48, to: 0.56, style: 'wood' },
      { type: 'crowd', at: 0.01, side: -1, length: 80, grandstand: true },
      { type: 'crowd', at: 0.3, side: 1, length: 60 },
      { type: 'hazard', kind: 'bales', at: 0.62, period: 18, side: -1 },
      { type: 'shortcut', points: [[-60, 12, 280], [-120, 11, 250], [-200, 10, 260], [-260, 9, 300]], entry: 0.45, exit: 0.6, surface: 'dirt', width: 7 },
      { type: 'pit', from: 0.88, to: 0.98, side: -1 },
      { type: 'jump', at: 0.2 },
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'woodland-raceway',
    name: 'Woodland Raceway',
    location: 'Ardenne Forest, Belgium',
    description: 'Flowing forest curves, an old stone bridge over the creek and a logging crossing. Grip changes with every patch of damp shade.',
    theme: 'woodland',
    closed: true,
    width: 12,
    difficulty: 2,
    unlockLevel: 1,
    defaultLaps: 3,
    lengthKm: 5.1,
    bestLapReference: 128,
    environment: env({ terrain: 'hills', terrainAmplitude: 26, defaultHour: 8, defaultWeather: 'cloudy', skyTint: '#b9d2e6', groundColor: '#3f6a2f', treeDensity: 1.8, fogDensity: 0.0032, weatherOptions: ['clear', 'cloudy', 'overcast', 'rain', 'fog', 'storm'] }),
    points: [
      [0, 10, 0], [160, 12, 20], [300, 18, 90], [380, 26, 220], [330, 32, 360], [200, 36, 430], [60, 34, 380], [-40, 30, 460], [-180, 28, 520], [-330, 24, 470],
      [-400, 20, 330], [-360, 16, 190], [-440, 14, 60], [-380, 12, -60], [-220, 10, -90], [-90, 9, -60],
    ],
    features: [
      { type: 'bridge', from: 0.6, to: 0.66, style: 'concrete' },
      { type: 'tunnel', from: 0.24, to: 0.3, style: 'rock' },
      { type: 'crowd', at: 0.01, side: 1, length: 100, grandstand: true },
      { type: 'crowd', at: 0.5, side: -1, length: 40 },
      { type: 'hazard', kind: 'truck', at: 0.78, period: 22 },
      { type: 'shortcut', points: [[-360, 16, 190], [-300, 14, 120], [-320, 13, 20], [-380, 12, -60]], entry: 0.72, exit: 0.83, surface: 'gravel', width: 7 },
      { type: 'pit', from: 0.9, to: 0.99, side: 1 },
      { type: 'jump', at: 0.34 },
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'metro-loop',
    name: 'Metro Loop',
    location: 'Downtown Harbor City',
    description: 'Ninety-degree street corners between skyscrapers, an underpass beneath the plaza, a freeway overpass and a level crossing that does not care about your lap.',
    theme: 'metro',
    closed: true,
    width: 14,
    difficulty: 3,
    unlockLevel: 4,
    defaultLaps: 3,
    lengthKm: 4.2,
    bestLapReference: 104,
    environment: env({ terrain: 'city', terrainAmplitude: 2, defaultHour: 17, skyTint: '#9cc6ff', groundColor: '#55585e', roadColor: '#2b2c30', treeDensity: 0.25, buildingDensity: 1.4, hasStreetLights: true, fogDensity: 0.0026, weatherOptions: ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog'] }),
    points: [
      [0, 3, 0], [200, 3, 0], [320, 3, 10], [340, 3, 120], [330, -4, 240], [340, 3, 360], [240, 3, 380], [120, 9, 380], [0, 12, 380], [-120, 9, 380],
      [-240, 3, 380], [-260, 3, 260], [-180, 3, 200], [-190, 3, 90], [-300, 3, 60], [-320, 3, -60], [-180, 3, -80], [-60, 3, -40],
    ],
    features: [
      { type: 'tunnel', from: 0.2, to: 0.28, style: 'concrete' },
      { type: 'bridge', from: 0.4, to: 0.53, style: 'concrete' },
      { type: 'crowd', at: 0.01, side: -1, length: 120, grandstand: true },
      { type: 'crowd', at: 0.6, side: 1, length: 60 },
      { type: 'crowd', at: 0.85, side: -1, length: 50 },
      { type: 'hazard', kind: 'train', at: 0.7, period: 20 },
      { type: 'shortcut', points: [[-180, 3, 200], [-120, 3, 150], [-130, 3, 60], [-180, 3, -80]], entry: 0.65, exit: 0.88, surface: 'concrete', width: 7 },
      { type: 'pit', from: 0.9, to: 0.99, side: 1 },
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'badlands-run',
    name: 'Badlands Run',
    location: 'Sonoran Outback, Arizona',
    description: 'A canyon sprint through red rock: a mine tunnel, a rickety trestle bridge and mine carts on a schedule of their own. Gravel everywhere you don\'t want it.',
    theme: 'badlands',
    closed: false,
    width: 12,
    difficulty: 3,
    unlockLevel: 6,
    defaultLaps: 1,
    lengthKm: 6.2,
    bestLapReference: 165,
    environment: env({ terrain: 'canyon', terrainAmplitude: 40, defaultHour: 18, skyTint: '#ffc79a', groundColor: '#9b5a34', roadColor: '#3a3230', treeDensity: 0.3, fogDensity: 0.0015, weatherOptions: ['clear', 'cloudy', 'overcast', 'fog'] }),
    points: [
      [0, 20, 0], [200, 22, 40], [400, 28, 20], [560, 36, 120], [640, 44, 300], [560, 52, 480], [640, 56, 660], [820, 60, 760], [1000, 62, 700], [1100, 68, 540],
      [1240, 74, 440], [1420, 76, 500], [1560, 80, 660], [1720, 82, 700], [1900, 84, 640], [2040, 86, 520],
    ],
    features: [
      { type: 'tunnel', from: 0.33, to: 0.4, style: 'rock' },
      { type: 'bridge', from: 0.58, to: 0.64, style: 'wood' },
      { type: 'crowd', at: 0.01, side: 1, length: 60 },
      { type: 'crowd', at: 0.97, side: -1, length: 80, grandstand: true },
      { type: 'hazard', kind: 'carts', at: 0.47, period: 16 },
      { type: 'hazard', kind: 'rockfall', at: 0.8, period: 12 },
      { type: 'shortcut', points: [[640, 44, 300], [700, 46, 380], [720, 50, 500], [640, 56, 660]], entry: 0.26, exit: 0.4, surface: 'gravel', width: 7 },
      { type: 'jump', at: 0.55 },
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'alpine-ridge',
    name: 'Alpine Ridge',
    location: 'Stelvio Massif, Italian Alps',
    description: 'Hairpins stacked up a mountain face, a tunnel bored through the ridge and a viaduct over the gorge. Rockfall closes lines without warning.',
    theme: 'alpine',
    closed: true,
    width: 11,
    difficulty: 4,
    unlockLevel: 8,
    defaultLaps: 2,
    lengthKm: 6.8,
    bestLapReference: 178,
    environment: env({ terrain: 'mountain', terrainAmplitude: 90, defaultHour: 9, skyTint: '#a6d0ff', groundColor: '#5b7a4a', treeDensity: 1.0, fogDensity: 0.0028, weatherOptions: ['clear', 'cloudy', 'overcast', 'rain', 'fog', 'storm', 'snow'] }),
    points: [
      [0, 20, 0], [180, 24, 40], [300, 34, 160], [260, 48, 300], [120, 60, 340], [40, 74, 460], [160, 90, 560], [320, 104, 520], [420, 118, 640], [300, 132, 760],
      [120, 138, 720], [-60, 134, 800], [-240, 126, 760], [-320, 110, 600], [-220, 94, 480], [-340, 78, 360], [-460, 60, 220], [-380, 42, 80], [-220, 30, -20], [-90, 24, -40],
    ],
    features: [
      { type: 'tunnel', from: 0.42, to: 0.5, style: 'rock' },
      { type: 'bridge', from: 0.76, to: 0.83, style: 'concrete' },
      { type: 'crowd', at: 0.01, side: -1, length: 70, grandstand: true },
      { type: 'hazard', kind: 'rockfall', at: 0.62, period: 11 },
      { type: 'hazard', kind: 'rockfall', at: 0.9, period: 15 },
      { type: 'shortcut', points: [[-320, 110, 600], [-360, 100, 520], [-400, 88, 440], [-340, 78, 360]], entry: 0.67, exit: 0.78, surface: 'dirt', width: 6 },
      { type: 'pit', from: 0.92, to: 0.99, side: -1 },
      { type: 'jump', at: 0.3 },
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'shipyard-district',
    name: 'Shipyard District',
    location: 'Rotterdam Docklands',
    description: 'Container canyons, a steel bascule bridge over the canal and a gantry crane that swings freight straight across the racing line.',
    theme: 'shipyard',
    closed: true,
    width: 13,
    difficulty: 3,
    unlockLevel: 10,
    defaultLaps: 3,
    lengthKm: 4.4,
    bestLapReference: 110,
    environment: env({ terrain: 'flat', terrainAmplitude: 1.5, waterLevel: 0.2, defaultHour: 19, defaultWeather: 'overcast', skyTint: '#8fa9c0', groundColor: '#5d6167', roadColor: '#2c2d30', treeDensity: 0.05, buildingDensity: 0.9, hasStreetLights: true, fogDensity: 0.003, weatherOptions: ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog'] }),
    points: [
      [0, 3, 0], [220, 3, 0], [380, 3, 60], [400, 3, 200], [300, 10, 300], [140, 10, 320], [20, 3, 400], [-140, 3, 420], [-300, 3, 360], [-360, 3, 220],
      [-280, 3, 120], [-320, 3, 0], [-200, 3, -60], [-80, 3, -30],
    ],
    features: [
      { type: 'bridge', from: 0.3, to: 0.4, style: 'steel' },
      { type: 'tunnel', from: 0.55, to: 0.61, style: 'steel' },
      { type: 'crowd', at: 0.01, side: 1, length: 90, grandstand: true },
      { type: 'crowd', at: 0.45, side: -1, length: 50 },
      { type: 'hazard', kind: 'crane', at: 0.68, period: 12 },
      { type: 'hazard', kind: 'gate', at: 0.2, period: 16, side: -1 },
      { type: 'shortcut', points: [[-280, 3, 120], [-200, 3, 80], [-160, 3, 0], [-200, 3, -60]], entry: 0.73, exit: 0.9, surface: 'concrete', width: 7 },
      { type: 'pit', from: 0.9, to: 0.99, side: -1 },
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'glacier-road',
    name: 'Glacier Road',
    location: 'Jökulsá Pass, Iceland',
    description: 'Ice patches migrate across a snowbound mountain road; an ice tunnel and a crevasse bridge break up the white. Winter tyres strongly recommended.',
    theme: 'glacier',
    closed: true,
    width: 12,
    difficulty: 4,
    unlockLevel: 12,
    defaultLaps: 2,
    lengthKm: 5.6,
    bestLapReference: 160,
    environment: env({ terrain: 'mountain', terrainAmplitude: 55, snow: true, defaultHour: 11, defaultWeather: 'cloudy', skyTint: '#c9dcee', groundColor: '#e8eef4', roadColor: '#4a4f57', treeDensity: 0.35, fogDensity: 0.0036, weatherOptions: ['clear', 'cloudy', 'overcast', 'snow', 'blizzard', 'fog'] }),
    points: [
      [0, 30, 0], [200, 34, 30], [360, 44, 120], [400, 56, 300], [300, 64, 440], [140, 70, 520], [-40, 72, 600], [-220, 68, 560], [-380, 62, 420], [-420, 54, 260],
      [-340, 46, 120], [-400, 40, -20], [-260, 34, -80], [-100, 30, -50],
    ],
    features: [
      { type: 'tunnel', from: 0.36, to: 0.44, style: 'ice' },
      { type: 'bridge', from: 0.62, to: 0.68, style: 'steel' },
      { type: 'crowd', at: 0.01, side: 1, length: 60 },
      { type: 'hazard', kind: 'ice', at: 0.15, period: 25, span: 60 },
      { type: 'hazard', kind: 'ice', at: 0.52, period: 30, span: 80 },
      { type: 'hazard', kind: 'avalanche', at: 0.8, period: 17 },
      { type: 'shortcut', points: [[-340, 46, 120], [-300, 42, 40], [-300, 36, -60], [-260, 34, -80]], entry: 0.77, exit: 0.9, surface: 'snow', width: 7 },
      { type: 'pit', from: 0.92, to: 0.99, side: 1 },
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'neon-boulevard',
    name: 'Neon Boulevard',
    location: 'Shinjuku After Dark',
    description: 'Rain-slick asphalt under a thousand signs. A spiral overpass, a tunnel beneath the station and fountains that flood the chicane. Reflections everywhere.',
    theme: 'neon',
    closed: true,
    width: 13,
    difficulty: 5,
    unlockLevel: 15,
    defaultLaps: 3,
    lengthKm: 4.9,
    bestLapReference: 122,
    environment: env({ terrain: 'city', terrainAmplitude: 2, defaultHour: 22, defaultWeather: 'rain', skyTint: '#2a1b4d', groundColor: '#26262c', roadColor: '#1d1e22', treeDensity: 0.1, buildingDensity: 1.6, hasStreetLights: true, hasNeon: true, fogDensity: 0.0042, weatherOptions: ['clear', 'cloudy', 'rain', 'storm', 'fog'] }),
    points: [
      [0, 3, 0], [220, 3, 0], [360, 3, 80], [400, 12, 220], [340, 20, 340], [200, 22, 380], [80, 14, 320], [40, 3, 200], [-80, 3, 180], [-200, -5, 240],
      [-340, 3, 320], [-440, 3, 220], [-400, 3, 80], [-300, 3, -40], [-140, 3, -60], [-40, 3, -30],
    ],
    features: [
      { type: 'bridge', from: 0.18, to: 0.36, style: 'concrete' },
      { type: 'tunnel', from: 0.55, to: 0.63, style: 'neon' },
      { type: 'crowd', at: 0.01, side: -1, length: 110, grandstand: true },
      { type: 'crowd', at: 0.4, side: 1, length: 60 },
      { type: 'crowd', at: 0.75, side: -1, length: 60 },
      { type: 'hazard', kind: 'fountain', at: 0.7, period: 10, span: 30 },
      { type: 'hazard', kind: 'gate', at: 0.85, period: 13, side: 1 },
      { type: 'shortcut', points: [[40, 3, 200], [0, 3, 120], [-60, 3, 40], [-140, 3, -60]], entry: 0.46, exit: 0.9, surface: 'concrete', width: 7 },
      { type: 'pit', from: 0.92, to: 0.99, side: 1 },
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
]

export const TRACK_BY_ID: Record<string, TrackDefinition> = Object.fromEntries(TRACK_CATALOG.map((t) => [t.id, t]))

export function getTrackDefinition(id: string): TrackDefinition {
  const t = TRACK_BY_ID[id]
  if (!t) {
    console.warn(`[Tracks] Unknown track "${id}", falling back to ${TRACK_CATALOG[0].id}`)
    return TRACK_CATALOG[0]
  }
  return t
}

export const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: 'Clear',
  cloudy: 'Scattered Cloud',
  overcast: 'Overcast',
  rain: 'Rain',
  storm: 'Thunderstorm',
  fog: 'Fog',
  snow: 'Snowfall',
  blizzard: 'Blizzard',
}
