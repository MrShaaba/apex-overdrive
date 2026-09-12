/**
 * The circuits. Control points are metres (X east, Y up, Z north). Every
 * feature is declared in normalised spline parameter space (0..1) so a layout
 * can be re-shaped without breaking its tunnels, bridges or crowd zones.
 *
 * Nine circuits are procedural; a licensed circuit model (`model`) supplies
 * its road, terrain, walls and scenery from a .glb built by
 * tools/asset-pipeline/prepare-track.mjs, with its control points derived
 * from the road mesh by the same tool (data/*.points.json).
 */

import type { SurfaceType } from '../physics/Surfaces'
import driftPoints from './data/drift.points.json'
import spaPoints from './data/spa.points.json'
import bugattiPoints from './data/bugatti.points.json'
import hungaroringPoints from './data/hungaroring.points.json'
import sepangPoints from './data/sepang.points.json'
import shanghaiPoints from './data/shanghai.points.json'
import marinaPoints from './data/marina.points.json'
import indianapolisPoints from './data/indianapolis.points.json'
import suzukaPoints from './data/suzuka.points.json'

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

/** Licensed circuit model; the road/terrain/wall/prop nodes are baked by prepare-track.mjs. */
export interface TrackModelRef {
  /** Path under the app base URL, e.g. 'assets/models/tracks/drift.glb'. */
  file: string
  /** One-line credit (licence requirement). */
  credit: string
}

/**
 * Photo billboards around the lap (tracks/Billboards.ts). Opt-in: absent on every
 * stock circuit, so nothing changes for them.
 */
export interface PhotoBillboardConfig {
  /** Folder of the photo set under the app base URL; 'assets/photos/fam-jam' when absent. */
  set?: string
  /** How many hoardings to spread around the lap. */
  count: number
  /** Roughly where along the lap (normalised 0..1) and on which side; the whole lap, alternating sides, when absent. */
  zones?: { from: number; to: number; side: -1 | 1 | 'alternate' }[]
}

export interface TrackDefinition {
  id: string
  name: string
  location: string
  description: string
  theme: TrackTheme
  /** When set, the circuit's geometry comes from this file; `points` is its derived centreline. */
  model?: TrackModelRef
  points: [number, number, number][]
  /** Usable half-width at each control point (model circuits); `width / 2` when absent. */
  halfWidths?: number[]
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
  /** Trackside photo billboards; only Fam Jam variants set this. */
  photoBillboards?: PhotoBillboardConfig
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
  {
    id: 'drift-park',
    name: 'Drift Park',
    location: 'Licensed circuit model',
    description: 'A real drift circuit: 1.1 km of tight asphalt hairpins between guard rails and barrier cylinders, with a wide open paddock to slide around in. Every bit of it is drivable — the lap follows the perimeter of the road network.',
    theme: 'woodland',
    model: { file: 'assets/models/tracks/drift.glb', credit: '"Drift Race Track Free" by Nicholas-3D on Sketchfab, CC-BY-ND 4.0' },
    closed: true,
    width: 12,
    difficulty: 3,
    unlockLevel: 1,
    defaultLaps: 4,
    lengthKm: 1.15,
    bestLapReference: 54,
    environment: env({ terrain: 'flat', terrainAmplitude: 0, defaultHour: 15, skyTint: '#a4d0ff', groundColor: '#4f7a3a', treeDensity: 0, buildingDensity: 0, fogDensity: 0.0012, weatherOptions: ['clear', 'cloudy', 'overcast', 'rain'] }),
    points: driftPoints.points as [number, number, number][],
    features: [
      { type: 'pit', from: 0.13, to: 0.2, side: 1 },
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'spa',
    name: 'Spa-Francorchamps',
    location: 'Stavelot, Belgium',
    description: 'Seven kilometres through the Ardennes: the plunge into Eau Rouge and the climb up Raidillon, the long Kemmel straight, Pouhon, Blanchimont and the Bus Stop. The circuit every driver wants to master.',
    theme: 'woodland',
    model: { file: 'assets/models/tracks/spa.glb', credit: '"Circuit de Spa-Francorchamps 2022 layout" by Dave Love SketchFab, CC-BY 4.0' },
    closed: true,
    width: 13,
    difficulty: 5,
    unlockLevel: 1,
    defaultLaps: 3,
    lengthKm: +(spaPoints.lapMetres / 1000).toFixed(2),
    bestLapReference: 106,
    environment: env({ terrain: 'valley', terrainAmplitude: 0, defaultHour: 14, skyTint: '#9fc8f5', groundColor: '#4d7a3a', treeDensity: 0, buildingDensity: 0, fogDensity: 0.0009, weatherOptions: ['clear', 'cloudy', 'overcast', 'rain', 'fog'] }),
    points: spaPoints.points as [number, number, number][],
    halfWidths: spaPoints.halfWidths,
    features: [
      ...(spaPoints.features as { type: 'pit'; from: number; to: number; side: 1 | -1 }[]),
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'bugatti',
    name: 'Circuit Bugatti',
    location: 'Le Mans, France',
    description: 'The permanent circuit inside the 24 Hours track: the Dunlop curve and chicane, the S de la Forêt, Museum, Garage Vert and the Chemin aux Boeufs esses before the run back past the pits. Short, technical and flat out at the end.',
    theme: 'woodland',
    model: { file: 'assets/models/tracks/bugatti.glb', credit: '"Bugatti Circuit 2017 layout" by Dave Love SketchFab, CC-BY 4.0' },
    closed: true,
    width: 12,
    difficulty: 3,
    unlockLevel: 1,
    defaultLaps: 4,
    lengthKm: +(bugattiPoints.lapMetres / 1000).toFixed(2),
    bestLapReference: 92,
    environment: env({ terrain: 'valley', terrainAmplitude: 0, defaultHour: 15, skyTint: '#a8cdf0', groundColor: '#55803c', treeDensity: 0, buildingDensity: 0, fogDensity: 0.0008, weatherOptions: ['clear', 'cloudy', 'overcast', 'rain'] }),
    points: bugattiPoints.points as [number, number, number][],
    halfWidths: bugattiPoints.halfWidths,
    features: [
      ...(bugattiPoints.features as { type: 'pit'; from: number; to: number; side: 1 | -1 }[]),
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'hungaroring',
    name: 'Hungaroring',
    location: 'Mogyoród, Hungary',
    description: 'A twisting, dusty ribbon in a natural bowl outside Budapest: one real straight, then corner after corner with no room to rest. Hard to pass on, so qualifying and clean laps matter.',
    theme: 'woodland',
    model: { file: 'assets/models/tracks/hungaroring.glb', credit: '"Hungaroring 2020 layout" by Dave Love SketchFab, CC-BY 4.0' },
    closed: true,
    width: 13,
    difficulty: 4,
    unlockLevel: 1,
    defaultLaps: 4,
    lengthKm: +(hungaroringPoints.lapMetres / 1000).toFixed(2),
    bestLapReference: 76,
    environment: env({ terrain: 'valley', terrainAmplitude: 0, defaultHour: 13, skyTint: '#b7d3f2', groundColor: '#6b8a3e', treeDensity: 0, buildingDensity: 0, fogDensity: 0.0006, weatherOptions: ['clear', 'cloudy', 'overcast', 'rain'] }),
    points: hungaroringPoints.points as [number, number, number][],
    halfWidths: hungaroringPoints.halfWidths,
    features: [
      ...(hungaroringPoints.features as { type: 'pit'; from: number; to: number; side: 1 | -1 }[]),
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'sepang',
    name: 'Sepang International Circuit',
    location: 'Sepang, Malaysia',
    description: 'Two huge straights joined by a hairpin, then long, wide sweepers through the palm plantations. Fast, hot and humid: the wide track invites side-by-side racing all the way round.',
    theme: 'island',
    model: { file: 'assets/models/tracks/sepang.glb', credit: '"Sepang International Circuit 2025 layout" by Dave Love SketchFab, CC-BY 4.0' },
    closed: true,
    width: 14,
    difficulty: 3,
    unlockLevel: 1,
    defaultLaps: 3,
    lengthKm: +(sepangPoints.lapMetres / 1000).toFixed(2),
    bestLapReference: 100,
    environment: env({ terrain: 'valley', terrainAmplitude: 0, defaultHour: 14, skyTint: '#bcd6f0', groundColor: '#5f8a3a', treeDensity: 0, buildingDensity: 0, fogDensity: 0.0009, weatherOptions: ['clear', 'cloudy', 'overcast', 'rain', 'storm'] }),
    points: sepangPoints.points as [number, number, number][],
    halfWidths: sepangPoints.halfWidths,
    features: [
      ...(sepangPoints.features as { type: 'pit'; from: number; to: number; side: 1 | -1 }[]),
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'shanghai',
    name: 'Shanghai International Circuit',
    location: 'Jiading, Shanghai',
    description: 'The snail: Turn 1 keeps tightening for what feels like forever, then a long back straight ends in a hairpin. Huge run-offs and a 1.2 km blast to the last corner reward brave braking.',
    theme: 'metro',
    model: { file: 'assets/models/tracks/shanghai.glb', credit: '"Shanghai International Circuit 2018 layout" by Dave Love SketchFab, CC-BY 4.0' },
    closed: true,
    width: 14,
    difficulty: 3,
    unlockLevel: 1,
    defaultLaps: 3,
    lengthKm: +(shanghaiPoints.lapMetres / 1000).toFixed(2),
    bestLapReference: 96,
    environment: env({ terrain: 'valley', terrainAmplitude: 0, defaultHour: 15, skyTint: '#c9d4de', groundColor: '#6a8f45', treeDensity: 0, buildingDensity: 0, fogDensity: 0.0012, weatherOptions: ['clear', 'cloudy', 'overcast', 'fog', 'rain'] }),
    points: shanghaiPoints.points as [number, number, number][],
    halfWidths: shanghaiPoints.halfWidths,
    features: [
      ...(shanghaiPoints.features as { type: 'pit'; from: number; to: number; side: 1 | -1 }[]),
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'marina',
    name: 'Marina Bay Street Circuit',
    location: 'Singapore',
    description: 'Twenty-three corners of concrete walls under floodlights. No run-off, no rest: a bumpy street circuit where every kerb matters and a mistake means the barrier.',
    theme: 'neon',
    model: { file: 'assets/models/tracks/marina.glb', credit: '"Marina Bay Street Circuit" by Dave Love SketchFab, CC-BY 4.0' },
    closed: true,
    width: 13,
    difficulty: 5,
    unlockLevel: 1,
    defaultLaps: 3,
    lengthKm: +(marinaPoints.lapMetres / 1000).toFixed(2),
    bestLapReference: 104,
    environment: env({ terrain: 'valley', terrainAmplitude: 0, defaultHour: 19.5, skyTint: '#2b2f4a', groundColor: '#45503a', treeDensity: 0, buildingDensity: 0, fogDensity: 0.0015, weatherOptions: ['clear', 'cloudy', 'rain', 'storm'] }),
    points: marinaPoints.points as [number, number, number][],
    halfWidths: marinaPoints.halfWidths,
    features: [
      ...(marinaPoints.features as { type: 'pit'; from: number; to: number; side: 1 | -1 }[]),
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'indianapolis',
    name: 'Indianapolis Motor Speedway',
    location: 'Speedway, Indiana',
    description: 'The oval. Four banked corners, two long straights and the yard of bricks: flat out for two and a half miles a lap, drafting and dodging in a pack at 300 km/h.',
    theme: 'badlands',
    model: { file: 'assets/models/tracks/indianapolis.glb', credit: '"Indianapolis Motor Speedway" by Dave Love SketchFab, CC-BY 4.0' },
    closed: true,
    width: 15,
    difficulty: 2,
    unlockLevel: 1,
    defaultLaps: 5,
    lengthKm: +(indianapolisPoints.lapMetres / 1000).toFixed(2),
    bestLapReference: 50,
    environment: env({ terrain: 'valley', terrainAmplitude: 0, defaultHour: 12, skyTint: '#bfd6f0', groundColor: '#5f8a3a', treeDensity: 0, buildingDensity: 0, fogDensity: 0.0004, weatherOptions: ['clear', 'cloudy', 'overcast'] }),
    points: indianapolisPoints.points as [number, number, number][],
    halfWidths: indianapolisPoints.halfWidths,
    features: [
      ...(indianapolisPoints.features as { type: 'pit'; from: number; to: number; side: 1 | -1 }[]),
      { type: 'sector', at: 0.33 },
      { type: 'sector', at: 0.66 },
    ],
  },
  {
    id: 'suzuka',
    name: 'Suzuka Circuit',
    location: 'Suzuka, Japan',
    description: 'The figure-eight. The Esses flow uphill into Dunlop and Degner, the hairpin drops you onto Spoon, then the back straight fires you through 130R and over the crossover. A drivers\' circuit through and through.',
    theme: 'woodland',
    model: { file: 'assets/models/tracks/suzuka.glb', credit: '"Suzuka Circuit 2001 layout" by Dave Love SketchFab, CC-BY 4.0' },
    closed: true,
    width: 11,
    difficulty: 5,
    unlockLevel: 1,
    defaultLaps: 3,
    lengthKm: +(suzukaPoints.lapMetres / 1000).toFixed(2),
    bestLapReference: 92,
    environment: env({ terrain: 'valley', terrainAmplitude: 0, defaultHour: 14, skyTint: '#b9d0ea', groundColor: '#5c8a3c', treeDensity: 0, buildingDensity: 0, fogDensity: 0.0007, weatherOptions: ['clear', 'cloudy', 'overcast', 'rain', 'storm'] }),
    points: suzukaPoints.points as [number, number, number][],
    halfWidths: suzukaPoints.halfWidths,
    features: [
      ...(suzukaPoints.features as { type: 'pit'; from: number; to: number; side: 1 | -1 }[]),
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
