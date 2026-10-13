import type { DeviceProfile } from '../input/Gamepads'
/**
 * Player preferences + graphics quality presets.
 *
 * Quality presets are resolved into concrete renderer parameters by
 * `resolveQuality()`. `auto` inspects the device (GPU tier heuristics, pixel
 * ratio, touch) and picks a sensible starting preset; `QualityManager` can still
 * scale dynamically at runtime based on measured frame time.
 */

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'auto'
export type ShadowQuality = 'off' | 'low' | 'medium' | 'high'
export type AntiAliasMode = 'none' | 'fxaa' | 'smaa'
export type SpeedUnits = 'kmh' | 'mph'
export type TransmissionMode = 'auto' | 'manual'
export type DifficultyLevel = 'rookie' | 'amateur' | 'pro' | 'legend' | 'adaptive'
export type DamageMode = 'off' | 'visual' | 'full'
export type TouchLayout = 'buttons' | 'tilt' | 'wheel'
export type CameraMode = 'chase' | 'chaseFar' | 'cockpit' | 'hood' | 'cinematic' | 'replay' | 'photo'

export interface GraphicsSettings {
  preset: QualityPreset
  resolutionScale: number
  shadows: ShadowQuality
  ssao: boolean
  bloom: boolean
  motionBlur: boolean
  reflections: boolean
  particleDensity: number
  drawDistance: number
  antialias: AntiAliasMode
  fovBase: number
  dynamicScaling: boolean
  showFps: boolean
}

export interface AudioSettings {
  master: number
  engine: number
  sfx: number
  music: number
  ambience: number
  muteInBackground: boolean
}

export interface ControlSettings {
  /** Calibrated profiles by device ID + browser index (legacy ID-only keys supported). */
  devices: Record<string, DeviceProfile>
  /** Device instance assigned to player 1 and player 2 (null = first free device). */
  players: [string | null, string | null]
  /** Optional separate USB pedal device for each player. */
  pedals: [string | null, string | null]
  steeringSensitivity: number
  steeringDeadzone: number
  touchLayout: TouchLayout
  tiltSensitivity: number
  vibration: boolean
  transmission: TransmissionMode
  units: SpeedUnits
  abs: boolean
  tractionControl: boolean
  stabilityControl: boolean
  invertCameraY: boolean
}

export interface GameplaySettings {
  difficulty: DifficultyLevel
  damage: DamageMode
  fuelConsumption: boolean
  defaultCamera: CameraMode
  hudScale: number
  showMinimap: boolean
  showGhost: boolean
  playerName: string
}

export interface Settings {
  graphics: GraphicsSettings
  audio: AudioSettings
  controls: ControlSettings
  gameplay: GameplaySettings
}

export interface ResolvedQuality {
  resolutionScale: number
  shadowMapSize: number
  shadowsEnabled: boolean
  shadowDistance: number
  ssao: boolean
  bloom: boolean
  motionBlur: boolean
  reflections: boolean
  reflectionSize: number
  reflectionInterval: number
  particleBudget: number
  drawDistance: number
  antialias: AntiAliasMode
  anisotropy: number
  textureScale: number
  maxVisibleAI: number
  propDensity: number
  envMapSize: number
}

export const isTouchDevice = (): boolean =>
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)

export const isMobileDevice = (): boolean =>
  typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)

export function defaultSettings(): Settings {
  const mobile = isMobileDevice()
  return {
    graphics: {
      preset: 'auto',
      resolutionScale: 1,
      shadows: mobile ? 'low' : 'high',
      ssao: !mobile,
      bloom: true,
      motionBlur: !mobile,
      reflections: !mobile,
      particleDensity: mobile ? 0.5 : 1,
      drawDistance: mobile ? 0.6 : 1,
      antialias: mobile ? 'fxaa' : 'smaa',
      fovBase: 62,
      dynamicScaling: true,
      showFps: false,
    },
    audio: { master: 0.8, engine: 0.9, sfx: 0.9, music: 0.55, ambience: 0.7, muteInBackground: true },
    controls: {
      devices: {},
      players: [null, null],
      pedals: [null, null],
      steeringSensitivity: 1,
      steeringDeadzone: 0.08,
      touchLayout: 'buttons',
      tiltSensitivity: 1,
      vibration: true,
      transmission: 'auto',
      units: 'kmh',
      abs: true,
      tractionControl: true,
      stabilityControl: false,
      invertCameraY: false,
    },
    gameplay: {
      difficulty: 'adaptive',
      damage: 'full',
      fuelConsumption: true,
      defaultCamera: 'chase',
      hudScale: 1,
      showMinimap: true,
      showGhost: true,
      playerName: 'Driver',
    },
  }
}

/** Heuristic GPU tier detection: 0 = weak mobile, 1 = mid, 2 = strong desktop. */
export function detectGpuTier(): number {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (!gl) return 0
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).toLowerCase() : ''
    const mobile = isMobileDevice()
    if (/apple m[1-9]|rtx|radeon rx|geforce gtx 1[6-9]|geforce gtx 20|arc/.test(renderer)) return 2
    if (/adreno 7|mali-g7|apple a1[5-9]|apple gpu/.test(renderer)) return 1
    if (mobile) return 0
    if (/intel/.test(renderer)) return 1
    return 2
  } catch {
    return 1
  }
}

export function autoPreset(): Exclude<QualityPreset, 'auto'> {
  const tier = detectGpuTier()
  const mobile = isMobileDevice()
  if (mobile) return tier >= 1 ? 'medium' : 'low'
  if (tier >= 2) return 'high'
  return 'medium'
}

export function resolveQuality(g: GraphicsSettings): ResolvedQuality {
  const preset = g.preset === 'auto' ? autoPreset() : g.preset
  const base: Record<Exclude<QualityPreset, 'auto'>, ResolvedQuality> = {
    low: {
      resolutionScale: 0.7,
      shadowMapSize: 1024,
      shadowsEnabled: true,
      shadowDistance: 60,
      ssao: false,
      bloom: true,
      motionBlur: false,
      reflections: false,
      reflectionSize: 64,
      reflectionInterval: 8,
      particleBudget: 600,
      drawDistance: 400,
      antialias: 'none',
      anisotropy: 2,
      textureScale: 0.5,
      maxVisibleAI: 7,
      propDensity: 0.4,
      envMapSize: 128,
    },
    medium: {
      resolutionScale: 0.85,
      shadowMapSize: 2048,
      shadowsEnabled: true,
      shadowDistance: 90,
      ssao: false,
      bloom: true,
      motionBlur: true,
      reflections: true,
      reflectionSize: 128,
      reflectionInterval: 4,
      particleBudget: 1500,
      drawDistance: 650,
      antialias: 'fxaa',
      anisotropy: 4,
      textureScale: 0.75,
      maxVisibleAI: 13,
      propDensity: 0.7,
      envMapSize: 256,
    },
    high: {
      resolutionScale: 1,
      shadowMapSize: 4096,
      shadowsEnabled: true,
      shadowDistance: 140,
      ssao: true,
      bloom: true,
      motionBlur: true,
      reflections: true,
      reflectionSize: 256,
      reflectionInterval: 2,
      particleBudget: 3500,
      drawDistance: 1000,
      antialias: 'smaa',
      anisotropy: 8,
      textureScale: 1,
      maxVisibleAI: 13,
      propDensity: 1,
      envMapSize: 256,
    },
    ultra: {
      resolutionScale: 1,
      shadowMapSize: 4096,
      shadowsEnabled: true,
      shadowDistance: 200,
      ssao: true,
      bloom: true,
      motionBlur: true,
      reflections: true,
      reflectionSize: 512,
      reflectionInterval: 1,
      particleBudget: 6000,
      drawDistance: 1400,
      antialias: 'smaa',
      anisotropy: 16,
      textureScale: 1,
      maxVisibleAI: 13,
      propDensity: 1.25,
      envMapSize: 512,
    },
  }
  const q = { ...base[preset] }
  // Apply user overrides on top of the preset.
  q.resolutionScale = Math.min(q.resolutionScale, g.resolutionScale) * (g.resolutionScale >= 1 ? 1 : 1)
  if (g.preset !== 'auto') q.resolutionScale = g.resolutionScale
  q.shadowsEnabled = g.shadows !== 'off'
  q.shadowMapSize = g.shadows === 'low' ? 1024 : g.shadows === 'medium' ? 2048 : q.shadowMapSize
  q.ssao = q.ssao && g.ssao
  q.bloom = g.bloom
  q.motionBlur = q.motionBlur && g.motionBlur
  q.reflections = q.reflections && g.reflections
  q.particleBudget = Math.round(q.particleBudget * g.particleDensity)
  q.drawDistance = q.drawDistance * g.drawDistance
  q.antialias = g.antialias
  return q
}
