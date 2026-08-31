/**
 * Vehicle data model: base specifications, upgrade levels and cosmetic
 * customization. `applyUpgrades()` turns a catalog spec + upgrade state into the
 * "tuned" spec that the physics controller consumes, and `computeRatings()`
 * derives the 0–100 bars shown in the garage from the same numbers so the UI can
 * never drift from the simulation.
 */

export type VehicleClass = 'gt' | 'supercar' | 'roadster' | 'drift' | 'rally' | 'ev' | 'vintage' | 'track' | 'prototype'
export type Drivetrain = 'RWD' | 'AWD' | 'FWD'
export type EngineType = 'ice' | 'ev' | 'hybrid'
export type TireCompound = 'street' | 'sport' | 'semi-slick' | 'slick' | 'rally' | 'winter'
export type BodyShape = 'gt' | 'supercar' | 'roadster' | 'drift' | 'hatch' | 'ev' | 'vintage' | 'track' | 'prototype'

export interface VehicleSpec {
  id: string
  name: string
  brand: string
  vehicleClass: VehicleClass
  tagline: string
  description: string
  price: number
  unlockLevel: number
  tier: 1 | 2 | 3 | 4 | 5
  body: {
    shape: BodyShape
    length: number
    width: number
    height: number
    wheelbase: number
    trackWidth: number
    wheelRadius: number
    wheelWidth: number
    groundClearance: number
    rearOverhang: number
  }
  mass: number
  comHeight: number
  engine: {
    type: EngineType
    maxTorque: number
    peakRpm: number
    redline: number
    idleRpm: number
    cylinders: number
    turbo: boolean
    supercharged: boolean
    turboGain: number
    turboSpool: number
    soundProfile: 'v8' | 'v6' | 'v10' | 'v12' | 'i4' | 'flat6' | 'ev' | 'hybrid'
  }
  gearbox: {
    ratios: number[]
    finalDrive: number
    reverseRatio: number
    shiftTime: number
    drivetrain: Drivetrain
    /** 0 = all torque to front, 1 = all torque to rear. */
    rearBias: number
  }
  suspension: {
    stiffness: number
    dampingCompression: number
    dampingRebound: number
    restLength: number
    travel: number
    antiRoll: number
  }
  tires: {
    compound: TireCompound
    gripFront: number
    gripRear: number
    peakSlipAngle: number
    peakSlipRatio: number
    /** How much grip survives past the peak (0.5 = snappy, 0.9 = forgiving). */
    falloff: number
    rollingResistance: number
  }
  brakes: {
    maxTorque: number
    frontBias: number
    handbrakeTorque: number
  }
  aero: {
    dragCoefficient: number
    frontalArea: number
    downforceFront: number
    downforceRear: number
  }
  steering: {
    maxAngle: number
    speedSensitivity: number
    responseRate: number
  }
  performance: {
    /** Design top speed (km/h) — enforced as a soft limiter. */
    topSpeed: number
    fuelCapacity: number
    fuelConsumption: number
    nitroCapacity: number
    nitroPower: number
  }
  defaultPaint: string
  defaultAccent: string
}

export type UpgradeCategory = 'engine' | 'turbo' | 'gearbox' | 'suspension' | 'brakes' | 'tires' | 'weight' | 'nitro'
export type VehicleUpgrades = Record<UpgradeCategory, number>
export const UPGRADE_CATEGORIES: UpgradeCategory[] = ['engine', 'turbo', 'gearbox', 'suspension', 'brakes', 'tires', 'weight', 'nitro']
export const MAX_UPGRADE_LEVEL = 4

export interface UpgradeInfo {
  id: UpgradeCategory
  title: string
  description: string
  baseCost: number
  icon: string
}

export const UPGRADE_INFO: Record<UpgradeCategory, UpgradeInfo> = {
  engine: { id: 'engine', title: 'Motor', description: 'Ported heads, cams and ECU maps. More torque across the band.', baseCost: 6000, icon: '⚙️' },
  turbo: { id: 'turbo', title: 'Forced Induction', description: 'Bigger turbo / supercharger pulley. Stronger boost, faster spool.', baseCost: 7500, icon: '🌀' },
  gearbox: { id: 'gearbox', title: 'Gearbox', description: 'Close-ratio gearset and faster shifts.', baseCost: 5000, icon: '🔧' },
  suspension: { id: 'suspension', title: 'Dampers', description: 'Adjustable coilovers: stiffer springs, better body control.', baseCost: 4500, icon: '🛞' },
  brakes: { id: 'brakes', title: 'Brake Hardware', description: 'Larger rotors and multi-piston calipers.', baseCost: 4000, icon: '🛑' },
  tires: { id: 'tires', title: 'Tires', description: 'Stickier compound. More lateral and longitudinal grip.', baseCost: 3500, icon: '⭕' },
  weight: { id: 'weight', title: 'Lightweight Parts', description: 'Carbon panels and stripped interior. Less mass, sharper response.', baseCost: 8000, icon: '🪶' },
  nitro: { id: 'nitro', title: 'Boost Bottle', description: 'Bigger nitrous bottle and hotter jets.', baseCost: 3000, icon: '🧪' },
}

export function upgradeCost(category: UpgradeCategory, level: number, tier: number): number {
  const base = UPGRADE_INFO[category].baseCost
  return Math.round(base * (1 + level * 0.9) * (0.8 + tier * 0.25))
}

export function defaultUpgrades(): VehicleUpgrades {
  return { engine: 0, turbo: 0, gearbox: 0, suspension: 0, brakes: 0, tires: 0, weight: 0, nitro: 0 }
}

export type PaintFinish = 'gloss' | 'metallic' | 'matte' | 'pearl' | 'chrome' | 'satin'
export type RimStyle = 'sport5' | 'mesh' | 'turbine' | 'deepdish' | 'classic' | 'aero' | 'split10'
export type TireStyle = 'street' | 'sport' | 'semi-slick' | 'slick' | 'rally' | 'winter' | 'drift'
export type WingStyle = 'none' | 'lip' | 'ducktail' | 'gt' | 'swan' | 'dtm'
export type BumperStyle = 'stock' | 'street' | 'race' | 'widebody'
export type LiveryStyle = 'none' | 'stripes' | 'flames' | 'camo' | 'racing' | 'hex' | 'splash' | 'carbon' | 'retro'

export interface VehicleCustomization {
  paint: string
  accent: string
  finish: PaintFinish
  rims: RimStyle
  rimColor: string
  tires: TireStyle
  wing: WingStyle
  bumper: BumperStyle
  livery: LiveryStyle
  liveryColor: string
  windowTint: number
  plate: string
  raceNumber: number
}

export function defaultCustomization(spec: VehicleSpec): VehicleCustomization {
  return {
    paint: spec.defaultPaint,
    accent: spec.defaultAccent,
    finish: 'metallic',
    rims: 'sport5',
    rimColor: '#c9ccd4',
    tires: spec.tires.compound === 'rally' ? 'rally' : 'sport',
    wing: spec.vehicleClass === 'track' || spec.vehicleClass === 'prototype' ? 'gt' : 'none',
    bumper: 'stock',
    livery: 'none',
    liveryColor: '#ffffff',
    windowTint: 0.35,
    plate: 'APEX 01',
    raceNumber: 7,
  }
}

export const PAINT_SWATCHES: { name: string; hex: string }[] = [
  { name: 'Inferno Red', hex: '#d0102a' },
  { name: 'Apex Orange', hex: '#ff6a00' },
  { name: 'Volt Yellow', hex: '#ffd60a' },
  { name: 'Viper Green', hex: '#1fbf4a' },
  { name: 'Teal Surge', hex: '#12b3a6' },
  { name: 'Glacier Blue', hex: '#3d8bff' },
  { name: 'Midnight', hex: '#1a2140' },
  { name: 'Ultraviolet', hex: '#7b3cff' },
  { name: 'Magenta Pulse', hex: '#ff2d95' },
  { name: 'Pearl White', hex: '#f4f4f0' },
  { name: 'Gunmetal', hex: '#4a4f57' },
  { name: 'Obsidian', hex: '#0c0d10' },
  { name: 'Champagne', hex: '#c8b27a' },
  { name: 'British Racing', hex: '#0f4d2e' },
  { name: 'Rosso Corsa', hex: '#b1001a' },
  { name: 'Miami Aqua', hex: '#5af5e0' },
]

export const FINISHES: PaintFinish[] = ['gloss', 'metallic', 'matte', 'pearl', 'chrome', 'satin']
export const RIM_STYLES: RimStyle[] = ['sport5', 'mesh', 'turbine', 'deepdish', 'classic', 'aero', 'split10']
export const TIRE_STYLES: TireStyle[] = ['street', 'sport', 'semi-slick', 'slick', 'rally', 'winter', 'drift']
export const WING_STYLES: WingStyle[] = ['none', 'lip', 'ducktail', 'gt', 'swan', 'dtm']
export const BUMPER_STYLES: BumperStyle[] = ['stock', 'street', 'race', 'widebody']
export const LIVERY_STYLES: LiveryStyle[] = ['none', 'stripes', 'flames', 'camo', 'racing', 'hex', 'splash', 'carbon', 'retro']

/** Physics-relevant modifiers derived from cosmetic choices (tires and wings are functional). */
export interface CosmeticPhysicsModifiers {
  gripMultiplier: number
  looseSurfaceMultiplier: number
  wetMultiplier: number
  snowMultiplier: number
  downforceMultiplier: number
  dragMultiplier: number
  falloffDelta: number
  massDelta: number
}

export function cosmeticModifiers(c: VehicleCustomization): CosmeticPhysicsModifiers {
  const tireTable: Record<TireStyle, Partial<CosmeticPhysicsModifiers>> = {
    street: { gripMultiplier: 0.95, looseSurfaceMultiplier: 1, wetMultiplier: 1, snowMultiplier: 1 },
    sport: { gripMultiplier: 1, looseSurfaceMultiplier: 0.95, wetMultiplier: 0.97, snowMultiplier: 0.9 },
    'semi-slick': { gripMultiplier: 1.07, looseSurfaceMultiplier: 0.85, wetMultiplier: 0.85, snowMultiplier: 0.7 },
    slick: { gripMultiplier: 1.15, looseSurfaceMultiplier: 0.75, wetMultiplier: 0.6, snowMultiplier: 0.5 },
    rally: { gripMultiplier: 0.92, looseSurfaceMultiplier: 1.35, wetMultiplier: 1.1, snowMultiplier: 1.3 },
    winter: { gripMultiplier: 0.9, looseSurfaceMultiplier: 1.15, wetMultiplier: 1.15, snowMultiplier: 1.7 },
    drift: { gripMultiplier: 0.9, looseSurfaceMultiplier: 0.9, wetMultiplier: 0.9, snowMultiplier: 0.85, falloffDelta: 0.12 },
  }
  const wingTable: Record<WingStyle, { downforce: number; drag: number }> = {
    none: { downforce: 1, drag: 1 },
    lip: { downforce: 1.15, drag: 1.02 },
    ducktail: { downforce: 1.25, drag: 1.03 },
    gt: { downforce: 1.6, drag: 1.08 },
    swan: { downforce: 1.7, drag: 1.09 },
    dtm: { downforce: 1.9, drag: 1.12 },
  }
  const bumperMass: Record<BumperStyle, number> = { stock: 0, street: -5, race: -15, widebody: 25 }
  const t = tireTable[c.tires]
  const w = wingTable[c.wing]
  return {
    gripMultiplier: t.gripMultiplier ?? 1,
    looseSurfaceMultiplier: t.looseSurfaceMultiplier ?? 1,
    wetMultiplier: t.wetMultiplier ?? 1,
    snowMultiplier: t.snowMultiplier ?? 1,
    downforceMultiplier: w.downforce,
    dragMultiplier: w.drag * (c.bumper === 'widebody' ? 1.04 : c.bumper === 'race' ? 0.98 : 1),
    falloffDelta: t.falloffDelta ?? 0,
    massDelta: bumperMass[c.bumper],
  }
}

/** Deep-clone a spec and apply upgrade levels + cosmetic physics modifiers. */
export function applyUpgrades(base: VehicleSpec, u: VehicleUpgrades, c?: VehicleCustomization): VehicleSpec {
  const s: VehicleSpec = JSON.parse(JSON.stringify(base))
  const mods = c ? cosmeticModifiers(c) : null

  s.engine.maxTorque *= 1 + u.engine * 0.09
  s.engine.redline *= 1 + u.engine * 0.02
  s.engine.peakRpm *= 1 + u.engine * 0.015

  if (s.engine.type !== 'ev') {
    if (u.turbo > 0 && !s.engine.turbo && !s.engine.supercharged) s.engine.turbo = true
    s.engine.turboGain += u.turbo * 0.06
    s.engine.turboSpool *= 1 + u.turbo * 0.2
  } else {
    // For EVs "forced induction" maps to inverter/battery output upgrades.
    s.engine.maxTorque *= 1 + u.turbo * 0.05
  }

  s.gearbox.shiftTime *= 1 - u.gearbox * 0.15
  s.gearbox.finalDrive *= 1 + u.gearbox * 0.025

  s.suspension.stiffness *= 1 + u.suspension * 0.1
  s.suspension.dampingCompression *= 1 + u.suspension * 0.1
  s.suspension.dampingRebound *= 1 + u.suspension * 0.1
  s.suspension.antiRoll *= 1 + u.suspension * 0.15

  s.brakes.maxTorque *= 1 + u.brakes * 0.11

  s.tires.gripFront *= 1 + u.tires * 0.045
  s.tires.gripRear *= 1 + u.tires * 0.045

  s.mass -= u.weight * (s.mass * 0.03)

  s.performance.nitroCapacity *= 1 + u.nitro * 0.25
  s.performance.nitroPower += u.nitro * 0.05
  s.performance.topSpeed *= 1 + u.engine * 0.02 + u.turbo * 0.012

  if (mods) {
    s.tires.gripFront *= mods.gripMultiplier
    s.tires.gripRear *= mods.gripMultiplier
    s.tires.falloff += mods.falloffDelta
    s.aero.downforceFront *= mods.downforceMultiplier
    s.aero.downforceRear *= mods.downforceMultiplier
    s.aero.dragCoefficient *= mods.dragMultiplier
    s.mass += mods.massDelta
  }
  return s
}

export interface VehicleRatings {
  topSpeed: number
  acceleration: number
  handling: number
  braking: number
  drift: number
  offroad: number
  overall: number
  topSpeedKmh: number
  powerHp: number
  zeroToHundred: number
}

/** Derive display ratings from spec numbers (0–100 scale). */
export function computeRatings(s: VehicleSpec): VehicleRatings {
  const powerKw = (s.engine.maxTorque * (1 + (s.engine.turbo ? s.engine.turboGain : 0)) * s.engine.peakRpm) / 9549
  const powerHp = powerKw * 1.341
  const powerToWeight = powerHp / (s.mass / 1000)
  const zeroToHundred = Math.max(1.8, 18 / Math.sqrt(powerToWeight / 100) * (s.gearbox.drivetrain === 'AWD' ? 0.9 : 1))
  const avgGrip = (s.tires.gripFront + s.tires.gripRear) / 2
  const downforce = (s.aero.downforceFront + s.aero.downforceRear) / s.mass
  const brakingG = (s.brakes.maxTorque * 4) / s.body.wheelRadius / (s.mass * 9.81)
  const norm = (v: number, min: number, max: number) => Math.round(Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100)))
  const topSpeed = norm(s.performance.topSpeed, 160, 380)
  const acceleration = norm(10 - zeroToHundred, 1, 8.5)
  const handling = norm(avgGrip + downforce * 0.6 + s.steering.responseRate / 40 - s.mass / 6000, 0.6, 1.9)
  const braking = norm(brakingG, 0.6, 2.4)
  const drift = norm(s.tires.falloff * 0.5 + (s.gearbox.rearBias - 0.5) + s.steering.maxAngle / 60 + (1.3 - s.tires.gripRear) * 0.5, 0.4, 2.0)
  const offroad = norm(s.suspension.travel * 3 + (s.tires.compound === 'rally' ? 0.6 : 0) + (s.gearbox.drivetrain === 'AWD' ? 0.4 : 0) + s.body.groundClearance * 2, 0.5, 2.2)
  const overall = Math.round(topSpeed * 0.3 + acceleration * 0.3 + handling * 0.25 + braking * 0.15)
  return { topSpeed, acceleration, handling, braking, drift, offroad, overall, topSpeedKmh: Math.round(s.performance.topSpeed), powerHp: Math.round(powerHp), zeroToHundred: Math.round(zeroToHundred * 10) / 10 }
}
