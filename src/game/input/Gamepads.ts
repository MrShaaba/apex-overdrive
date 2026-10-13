/** Browser controller mappings. Profiles are saved per device ID and remain data-only. */
export interface AxisMap {
  axis: number
  /** Raw rest / full-left value. Inverted ranges are supported. */
  min: number
  /** Raw full-press / full-right value. */
  max: number
  /** Steering centre, captured independently of the end stops. */
  center?: number
}
export interface ButtonMap { button: number; min?: number; max?: number }
export type ControlMap = AxisMap | ButtonMap
export interface DeviceButtons {
  gearUp: number
  gearDown: number
  camera: number
  pause: number
  handbrake: number
  boost: number
  reset: number
  lookBack: number
}
export const BUTTON_LABELS: Record<keyof DeviceButtons, string> = {
  gearUp: 'Shift up', gearDown: 'Shift down', camera: 'Camera', pause: 'Pause / resume',
  handbrake: 'Handbrake', boost: 'ERS / boost', reset: 'Reset to track', lookBack: 'Look back',
}
export interface DeviceProfile {
  id: string
  kind: 'pad' | 'wheel' | 'pedals'
  steer: AxisMap
  throttle: ControlMap
  brake: ControlMap
  buttons: DeviceButtons
  calibrated: boolean
  /** Optional so existing saved profiles remain compatible. */
  steeringDeadzone?: number
  steeringLinearity?: number
  steeringSaturation?: number
  invertSteering?: boolean
  directSteering?: boolean
  pedalDeadzone?: number
  pedalSaturation?: number
}
export interface RawInput {
  steer: number
  throttle: number
  brake: number
  directSteering: boolean
  pressed: Record<keyof DeviceButtons, boolean>
  faceThrottle: number
  faceBrake: number
}
const WHEEL_ID = /G29|G920|G923|G27|G25|Driving Force|Logitech.*(Wheel|Racing)|T150|T300|T500|T248|T818|TX Racing|TS-PC|Fanatec|Thrustmaster.*(T\d{3}|Ferrari)|MOZA|Simucube|Simagic|Asetek|AccuForce|Cammus/i
export const isWheelId = (id: string): boolean => WHEEL_ID.test(id)
export const isAxisMap = (m: ControlMap): m is AxisMap => 'axis' in m
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const finite = (v: number | undefined, fallback: number) => v !== undefined && Number.isFinite(v) ? v : fallback
const clamp01 = (v: number) => clamp(finite(v, 0), 0, 1)

export function defaultProfile(id: string): DeviceProfile {
  const wheel = isWheelId(id)
  return {
    id, kind: wheel ? 'wheel' : 'pad',
    steer: { axis: 0, min: -1, max: 1, center: 0 },
    throttle: wheel ? { axis: 2, min: 1, max: -1 } : { button: 7 },
    brake: wheel ? { axis: 3, min: 1, max: -1 } : { button: 6 },
    buttons: { gearUp: wheel ? 4 : 5, gearDown: wheel ? 5 : 4, camera: 3, pause: 9, handbrake: 1, boost: wheel ? 0 : 10, reset: 8, lookBack: wheel ? 2 : 11 },
    calibrated: false,
  }
}

/** Raw axis to [0,1], with neutral output for disconnected or invalid channels. */
export function axisTo01(v: number, m: AxisMap): number {
  const span = m.max - m.min
  if (!Number.isFinite(v) || !Number.isFinite(span) || Math.abs(span) < 1e-4) return 0
  return clamp01((v - m.min) / span)
}
function readControl(gp: Gamepad, m: ControlMap): number {
  if (isAxisMap(m)) return axisTo01(gp.axes[m.axis] ?? m.min, m)
  const b = gp.buttons[m.button]
  if (!b) return 0
  return axisTo01(b.value ?? (b.pressed ? 1 : 0), { axis: 0, min: finite(m.min, 0), max: finite(m.max, 1) })
}
export function readDevice(gp: Gamepad, p: DeviceProfile, deadzone: number): RawInput {
  const center = finite(p.steer.center, (p.steer.min + p.steer.max) / 2)
  const mid = clamp(axisTo01(center, p.steer), 0.001, 0.999)
  const t = axisTo01(finite(gp.axes[p.steer.axis], center), p.steer)
  const validSteer = Number.isFinite(p.steer.max - p.steer.min) && Math.abs(p.steer.max - p.steer.min) > 1e-4
  let steer = validSteer ? (t < mid ? (t - mid) / mid : (t - mid) / (1 - mid)) : 0
  const dz = clamp(finite(p.steeringDeadzone, p.kind === 'wheel' ? 0.015 : deadzone), 0, 0.4)
  const saturation = clamp(finite(p.steeringSaturation, 1), dz + 0.05, 1)
  steer = Math.sign(steer) * Math.pow(clamp01((Math.abs(steer) - dz) / (saturation - dz)), clamp(finite(p.steeringLinearity, 1), 0.5, 3))
  if (p.invertSteering) steer *= -1
  const pressed = {} as Record<keyof DeviceButtons, boolean>
  for (const k of Object.keys(BUTTON_LABELS) as (keyof DeviceButtons)[]) pressed[k] = p.kind !== 'pedals' && (gp.buttons[p.buttons[k]]?.pressed ?? false)
  if (p.kind === 'pad') {
    const y = gp.axes[1] ?? 0
    if (y < -0.7) pressed.boost = true
    if (y > 0.7) pressed.lookBack = true
  }
  const pedalDz = clamp(finite(p.pedalDeadzone, 0.02), 0, 0.3)
  const pedalMax = clamp(finite(p.pedalSaturation, 1), pedalDz + 0.1, 1)
  const pedal = (m: ControlMap) => clamp01((readControl(gp, m) - pedalDz) / (pedalMax - pedalDz))
  return {
    steer: p.kind === 'pedals' ? 0 : steer,
    throttle: pedal(p.throttle), brake: pedal(p.brake),
    directSteering: p.kind === 'wheel' && p.directSteering !== false,
    pressed,
    faceThrottle: p.kind === 'pad' && gp.buttons[0]?.pressed ? 1 : 0,
    faceBrake: p.kind === 'pad' && gp.buttons[2]?.pressed ? 1 : 0,
  }
}

export type CalibrationStep = 'steer' | 'throttle' | 'brake' | 'gearUp' | 'gearDown' | 'camera' | 'pause' | 'done'
export const CALIBRATION_STEPS: CalibrationStep[] = ['steer', 'throttle', 'brake', 'gearUp', 'gearDown', 'camera', 'pause', 'done']
export const CALIBRATION_PROMPT: Record<CalibrationStep, string> = {
  steer: 'Start centred. Turn fully LEFT first, then fully RIGHT, return to centre and press Next.',
  throttle: 'Start with pedals released. Press the throttle pedal or trigger fully, release it, then press Next.',
  brake: 'Start with pedals released. Press the brake pedal or trigger fully, release it, then press Next.',
  gearUp: 'Press the button or paddle you want for shifting up.',
  gearDown: 'Press the button or paddle for shifting down.',
  camera: 'Press the button for changing camera.',
  pause: 'Press the button for pause and resume.',
  done: 'Review the controls below, then Save. Additional buttons and response curves are under Tune / test.',
}
interface AxisStats { rest: number; min: number; max: number; firstDirection: number }
const statsFor = (v: number): AxisStats => ({ rest: v, min: v, max: v, firstDirection: 0 })
const record = (s: AxisStats, v: number) => {
  s.min = Math.min(s.min, v)
  s.max = Math.max(s.max, v)
  if (!s.firstDirection && Math.abs(v - s.rest) > 0.25) s.firstDirection = Math.sign(v - s.rest)
}

/** Calibration observes both axes and analogue buttons; triggers need not expose an axis. */
export class Calibrator {
  readonly profile: DeviceProfile
  step: CalibrationStep
  private stats: AxisStats[] = []
  private buttonStats: AxisStats[] = []
  private buttonsAtStart: boolean[] = []
  private completed = new Set<CalibrationStep>()
  live = 0
  liveAxis = -1
  liveButton = -1
  constructor(existing: DeviceProfile) {
    this.profile = structuredClone(existing)
    this.profile.calibrated = false
    this.step = existing.kind === 'pedals' ? 'throttle' : 'steer'
  }
  begin(gp: Gamepad): void {
    this.stats = gp.axes.map((v) => statsFor(finite(v, 0)))
    this.buttonStats = gp.buttons.map((b) => statsFor(finite(b.value, b.pressed ? 1 : 0)))
    this.buttonsAtStart = gp.buttons.map((b) => b.pressed)
    this.live = 0
    this.liveAxis = -1
    this.liveButton = -1
  }
  sample(gp: Gamepad): number {
    gp.axes.forEach((v, i) => record(this.stats[i] ?? (this.stats[i] = statsFor(v)), finite(v, 0)))
    gp.buttons.forEach((b, i) => record(this.buttonStats[i] ?? (this.buttonStats[i] = statsFor(b.value)), finite(b.value, 0)))
    this.liveAxis = this.mostTravelled(this.stats)
    this.liveButton = this.step === 'steer' ? -1 : this.mostTravelled(this.buttonStats)
    if (this.liveAxis >= 0) {
      const s = this.stats[this.liveAxis]
      this.live = axisTo01(gp.axes[this.liveAxis], { axis: this.liveAxis, min: s.min, max: s.max })
    } else if (this.liveButton >= 0) this.live = clamp01(gp.buttons[this.liveButton].value)
    let pressed = -1
    for (let i = 0; i < gp.buttons.length; i++) {
      if (gp.buttons[i].pressed && !this.buttonsAtStart[i] && pressed < 0) pressed = i
      this.buttonsAtStart[i] = gp.buttons[i].pressed
    }
    return pressed
  }
  private mostTravelled(stats: AxisStats[]): number {
    let best = -1, span = 0.25
    stats.forEach((s, i) => { const d = s.max - s.min; if (d > span) { span = d; best = i } })
    return best
  }
  commit(gp: Gamepad, button = -1): boolean {
    const p = this.profile
    if (this.step === 'steer' || this.step === 'throttle' || this.step === 'brake') {
      const axis = this.mostTravelled(this.stats)
      const analogButton = this.mostTravelled(this.buttonStats)
      if (axis < 0) {
        if (this.step === 'steer' || analogButton < 0) return false
        const s = this.buttonStats[analogButton]
        const far = Math.abs(s.max - s.rest) > Math.abs(s.min - s.rest) ? s.max : s.min
        p[this.step] = { button: analogButton, min: s.rest, max: far }
      } else {
        const s = this.stats[axis]
        if (this.step === 'steer') {
          const center = finite(gp.axes[axis], s.rest)
          // Both end stops must lie on opposite sides of the released centre.
          if (center - s.min < 0.1 || s.max - center < 0.1) return false
          p.steer = { axis, min: s.firstDirection > 0 ? s.max : s.min, max: s.firstDirection > 0 ? s.min : s.max, center }
          p.invertSteering = false
        } else {
          const far = Math.abs(s.max - s.rest) > Math.abs(s.min - s.rest) ? s.max : s.min
          p[this.step] = { axis, min: s.rest, max: far }
        }
      }
    } else if (this.step !== 'done') {
      if (button < 0) return false
      for (const action of Object.keys(BUTTON_LABELS) as (keyof DeviceButtons)[]) if (p.buttons[action] === button) p.buttons[action] = -1
      p.buttons[this.step] = button
    }
    this.completed.add(this.step)
    this.advance(gp)
    return true
  }
  private advance(gp: Gamepad): void {
    const i = CALIBRATION_STEPS.indexOf(this.step)
    this.step = this.profile.kind === 'pedals' && this.step === 'brake' ? 'done' : CALIBRATION_STEPS[Math.min(CALIBRATION_STEPS.length - 1, i + 1)]
    if (this.step === 'done') this.profile.calibrated = (this.profile.kind === 'pedals' ? ['throttle', 'brake'] : ['steer', 'throttle', 'brake']).every((s) => this.completed.has(s as CalibrationStep))
    this.begin(gp)
  }
  skip(gp: Gamepad): void { this.advance(gp) }
}
