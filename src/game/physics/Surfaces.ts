/**
 * Driving surface definitions. Every static collider registers a surface type;
 * the vehicle controller looks it up per wheel raycast to scale grip, rolling
 * resistance and which particle effect to spawn. Weather multipliers are
 * applied on top by `WeatherState`.
 */

export type SurfaceType = 'asphalt' | 'concrete' | 'curb' | 'gravel' | 'dirt' | 'grass' | 'sand' | 'snow' | 'ice' | 'metal' | 'wood' | 'water'

export interface SurfaceProps {
  grip: number
  rollingResistance: number
  /** Extra drag when off the racing surface (grass/sand slows you). */
  dragFactor: number
  /** Randomised bumpiness fed into the suspension. */
  roughness: number
  particle: 'none' | 'smoke' | 'dust' | 'gravel' | 'grass' | 'snow' | 'spray'
  loose: boolean
  skidSound: 'tarmac' | 'gravel' | 'snow' | 'none'
}

export const SURFACES: Record<SurfaceType, SurfaceProps> = {
  asphalt: { grip: 1.0, rollingResistance: 1.0, dragFactor: 0, roughness: 0.0, particle: 'smoke', loose: false, skidSound: 'tarmac' },
  concrete: { grip: 0.96, rollingResistance: 1.0, dragFactor: 0, roughness: 0.02, particle: 'smoke', loose: false, skidSound: 'tarmac' },
  curb: { grip: 0.9, rollingResistance: 1.2, dragFactor: 0.02, roughness: 0.35, particle: 'smoke', loose: false, skidSound: 'tarmac' },
  gravel: { grip: 0.62, rollingResistance: 2.2, dragFactor: 0.05, roughness: 0.2, particle: 'gravel', loose: true, skidSound: 'gravel' },
  dirt: { grip: 0.68, rollingResistance: 1.8, dragFactor: 0.04, roughness: 0.15, particle: 'dust', loose: true, skidSound: 'gravel' },
  grass: { grip: 0.58, rollingResistance: 2.6, dragFactor: 0.06, roughness: 0.12, particle: 'grass', loose: true, skidSound: 'gravel' },
  sand: { grip: 0.55, rollingResistance: 3.2, dragFactor: 0.08, roughness: 0.1, particle: 'dust', loose: true, skidSound: 'gravel' },
  snow: { grip: 0.42, rollingResistance: 2.0, dragFactor: 0.05, roughness: 0.08, particle: 'snow', loose: true, skidSound: 'snow' },
  ice: { grip: 0.22, rollingResistance: 0.8, dragFactor: 0, roughness: 0.0, particle: 'none', loose: false, skidSound: 'none' },
  metal: { grip: 0.85, rollingResistance: 1.0, dragFactor: 0, roughness: 0.05, particle: 'none', loose: false, skidSound: 'tarmac' },
  wood: { grip: 0.8, rollingResistance: 1.1, dragFactor: 0, roughness: 0.08, particle: 'dust', loose: false, skidSound: 'tarmac' },
  water: { grip: 0.6, rollingResistance: 3.0, dragFactor: 0.12, roughness: 0.0, particle: 'spray', loose: false, skidSound: 'none' },
}

export interface WeatherGripState {
  /** 0 = dry, 1 = fully wet. */
  wetness: number
  /** 0 = none, 1 = deep snow. */
  snowCover: number
  /** 0 = none, 1 = glazed. */
  iceCover: number
}

/** Combine surface, weather and tyre compound into a final grip multiplier. */
export function effectiveGrip(
  surface: SurfaceType,
  weather: WeatherGripState,
  tyre: { looseSurfaceMultiplier: number; wetMultiplier: number; snowMultiplier: number },
): number {
  const p = SURFACES[surface]
  let grip = p.grip
  if (p.loose) grip *= tyre.looseSurfaceMultiplier
  // Wet tarmac loses ~25% grip; loose surfaces get muddier.
  const wetLoss = p.loose ? 0.2 : 0.28
  grip *= 1 - weather.wetness * wetLoss * (2 - tyre.wetMultiplier)
  // Snow cover blends the surface towards the snow coefficient.
  if (weather.snowCover > 0 && surface !== 'ice') {
    const snowGrip = SURFACES.snow.grip * tyre.snowMultiplier
    grip = grip * (1 - weather.snowCover) + snowGrip * weather.snowCover
  }
  if (weather.iceCover > 0) grip = grip * (1 - weather.iceCover) + SURFACES.ice.grip * weather.iceCover
  return Math.max(0.12, grip)
}

/** Collision group bitmasks (Rapier interaction groups: membership << 16 | filter). */
export const CollisionGroup = {
  GROUND: 0x0001,
  VEHICLE: 0x0002,
  PROP: 0x0004,
  HAZARD: 0x0008,
  TRIGGER: 0x0010,
  ALL: 0xffff,
} as const

export const makeGroups = (membership: number, filter: number): number => ((membership & 0xffff) << 16) | (filter & 0xffff)
