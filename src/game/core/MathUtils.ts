/**
 * Small, allocation-free math helpers used across physics, AI and rendering.
 */

export interface Vector3Like {
  x: number
  y: number
  z: number
}

export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v)
export const clamp01 = (v: number): number => clamp(v, 0, 1)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const inverseLerp = (a: number, b: number, v: number): number => (a === b ? 0 : clamp01((v - a) / (b - a)))
export const remap = (v: number, inMin: number, inMax: number, outMin: number, outMax: number): number =>
  lerp(outMin, outMax, inverseLerp(inMin, inMax, v))
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = inverseLerp(a, b, v)
  return t * t * (3 - 2 * t)
}
export const sign = (v: number): number => (v < 0 ? -1 : v > 0 ? 1 : 0)
export const wrap = (v: number, min: number, max: number): number => {
  const range = max - min
  return ((((v - min) % range) + range) % range) + min
}
export const degToRad = (deg: number): number => (deg * Math.PI) / 180
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI
export const kmh = (ms: number): number => ms * 3.6
export const mph = (ms: number): number => ms * 2.23694

/** Frame-rate independent exponential damping. `rate` ≈ how quickly we close the gap per second. */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-rate * dt))

/** Move towards target by at most `maxDelta`. */
export const moveTowards = (current: number, target: number, maxDelta: number): number => {
  const d = target - current
  if (Math.abs(d) <= maxDelta) return target
  return current + sign(d) * maxDelta
}

/** Shortest signed angular difference in radians. */
export const angleDelta = (a: number, b: number): number => wrap(b - a, -Math.PI, Math.PI)

/** Deterministic seeded PRNG (mulberry32). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Hash a string into a 32-bit seed. */
export function hashString(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 2D value noise with smooth interpolation — used for terrain and procedural textures. */
export function valueNoise2D(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const h = (ix: number, iy: number) => {
    let n = ix * 374761393 + iy * 668265263 + seed * 1442695041
    n = (n ^ (n >>> 13)) * 1274126177
    n = n ^ (n >>> 16)
    return (n >>> 0) / 4294967296
  }
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = h(xi, yi)
  const b = h(xi + 1, yi)
  const c = h(xi, yi + 1)
  const d = h(xi + 1, yi + 1)
  return lerp(lerp(a, b, u), lerp(c, d, u), v)
}

/** Fractal Brownian motion over `valueNoise2D`. Returns roughly [-1, 1]. */
export function fbm2D(x: number, y: number, octaves = 4, seed = 0, lacunarity = 2, gain = 0.5): number {
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += (valueNoise2D(x * freq, y * freq, seed + i * 17) * 2 - 1) * amp
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return sum / norm
}

export const formatTime = (seconds: number): string => {
  if (!isFinite(seconds) || seconds < 0) return '--:--.---'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds * 1000) % 1000)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`
}

export const formatCredits = (n: number): string => `${Math.round(n).toLocaleString('en-US')} CR`

export const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
