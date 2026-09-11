/**
 * Gamepad and racing-wheel device profiles.
 *
 * The Gamepad API hands a racing wheel over as a pad with odd axes: steering on
 * one axis, each pedal on its own axis, often resting at +1 and pressed at -1, or
 * split across half ranges, and no two drivers agree on buttons. A DeviceProfile
 * says which axis or button feeds which control and over what raw range, so the
 * game reads every device through the same mapping. Profiles are saved per
 * device id; a device without one gets a sensible default (standard pad
 * mapping, or a Logitech-style wheel mapping when the id looks like a wheel) and
 * the calibration screen replaces it. Force feedback is not exposed to browsers
 * and is not attempted.
 */

export interface AxisMap {
  axis: number
  /** Raw value at rest / full left (steer) … */
  min: number
  /** … and at full press / full right. May be below `min` for inverted axes. */
  max: number
}
export interface ButtonMap {
  button: number
}
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

export interface DeviceProfile {
  id: string
  kind: 'pad' | 'wheel'
  steer: AxisMap
  throttle: ControlMap
  brake: ControlMap
  buttons: DeviceButtons
  /** Set once the calibration screen has been through this device. */
  calibrated: boolean
}

export interface RawInput {
  steer: number
  throttle: number
  brake: number
  pressed: Record<keyof DeviceButtons, boolean>
  /** Raw button 0 / 2 for pads: face buttons double as throttle / brake. */
  faceThrottle: number
  faceBrake: number
}

const WHEEL_ID = /G29|G920|G923|G27|G25|Driving Force|Logitech.*(Wheel|Racing)|T150|T300|T500|TX Racing|TS-PC|Fanatec|Thrustmaster.*(T\d{3}|Ferrari)|MOZA|Simucube/i

export const isWheelId = (id: string): boolean => WHEEL_ID.test(id)

export const isAxisMap = (m: ControlMap): m is AxisMap => (m as AxisMap).axis !== undefined

export function defaultProfile(id: string): DeviceProfile {
  if (isWheelId(id)) {
    // Logitech G-series in Chrome: steering on axis 0, pedals on their own axes resting
    // at +1 and pressed at -1; paddles on buttons 4/5. Calibration fixes the rest.
    return {
      id,
      kind: 'wheel',
      steer: { axis: 0, min: -1, max: 1 },
      throttle: { axis: 2, min: 1, max: -1 },
      brake: { axis: 3, min: 1, max: -1 },
      buttons: { gearUp: 4, gearDown: 5, camera: 3, pause: 9, handbrake: 1, boost: 0, reset: 8, lookBack: 2 },
      calibrated: false,
    }
  }
  // Standard-mapping pad: left stick X, triggers as analogue buttons, bumpers to shift.
  return {
    id,
    kind: 'pad',
    steer: { axis: 0, min: -1, max: 1 },
    throttle: { button: 7 },
    brake: { button: 6 },
    buttons: { gearUp: 5, gearDown: 4, camera: 3, pause: 9, handbrake: 1, boost: 10, reset: 8, lookBack: 11 },
    calibrated: false,
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Raw axis value → 0..1 over the profile's range (inverted ranges work the same way). */
export function axisTo01(v: number, m: AxisMap): number {
  const span = m.max - m.min
  if (Math.abs(span) < 1e-4) return 0
  return clamp01((v - m.min) / span)
}

function readControl(gp: Gamepad, m: ControlMap): number {
  if (isAxisMap(m)) return axisTo01(gp.axes[m.axis] ?? m.min, m)
  const b = gp.buttons[m.button]
  return b ? (b.value ?? (b.pressed ? 1 : 0)) : 0
}

export function readDevice(gp: Gamepad, p: DeviceProfile, deadzone: number): RawInput {
  const t = axisTo01(gp.axes[p.steer.axis] ?? (p.steer.min + p.steer.max) / 2, p.steer)
  let steer = t * 2 - 1
  if (Math.abs(steer) < deadzone) steer = 0
  else steer = Math.sign(steer) * ((Math.abs(steer) - deadzone) / (1 - deadzone))
  const pressed = {} as Record<keyof DeviceButtons, boolean>
  for (const k of Object.keys(p.buttons) as (keyof DeviceButtons)[]) pressed[k] = gp.buttons[p.buttons[k]]?.pressed ?? false
  if (p.kind === 'pad') {
    // Left stick up / down double as nitrous / look back on pads.
    const y = gp.axes[1] ?? 0
    if (y < -0.7) pressed.boost = true
    if (y > 0.7) pressed.lookBack = true
  }
  return {
    steer,
    throttle: readControl(gp, p.throttle),
    brake: readControl(gp, p.brake),
    pressed,
    faceThrottle: p.kind === 'pad' ? (gp.buttons[0]?.pressed ? 1 : 0) : 0,
    faceBrake: p.kind === 'pad' ? (gp.buttons[2]?.pressed ? 1 : 0) : 0,
  }
}

// ---------------------------------------------------------------------------
// Calibration: a short sequence the screen walks through while sampling the device.

export type CalibrationStep = 'steer' | 'throttle' | 'brake' | 'gearUp' | 'gearDown' | 'camera' | 'pause' | 'done'
export const CALIBRATION_STEPS: CalibrationStep[] = ['steer', 'throttle', 'brake', 'gearUp', 'gearDown', 'camera', 'pause', 'done']

export const CALIBRATION_PROMPT: Record<CalibrationStep, string> = {
  steer: 'Turn the wheel (or push the stick) all the way left, then all the way right, then let it centre.',
  throttle: 'Press the throttle pedal (or trigger) all the way down, then release it.',
  brake: 'Press the brake pedal (or trigger) all the way down, then release it.',
  gearUp: 'Press the button or paddle you want for shifting up.',
  gearDown: 'Press the button or paddle for shifting down.',
  camera: 'Press the button for changing camera.',
  pause: 'Press the button for pause.',
  done: 'Saved. This device is calibrated.',
}

interface AxisStats {
  rest: number
  min: number
  max: number
}

/**
 * Watches a device during one calibration step. For an axis step it records the
 * resting value at the start and the extremes reached; the axis that travelled the
 * furthest is the one being calibrated (a pedal rests at one end and is pressed to
 * the other; a wheel rests in the middle). For a button step it waits for a press.
 */
export class Calibrator {
  readonly profile: DeviceProfile
  step: CalibrationStep = 'steer'
  private stats: AxisStats[] = []
  private buttonsAtStart: boolean[] = []
  /** Live 0..1 view of the axis currently moving the most, for the screen's bar. */
  live = 0
  liveAxis = -1

  constructor(existing: DeviceProfile) {
    this.profile = JSON.parse(JSON.stringify(existing)) as DeviceProfile
    this.profile.calibrated = false
  }

  begin(gp: Gamepad): void {
    this.stats = gp.axes.map((v) => ({ rest: v, min: v, max: v }))
    this.buttonsAtStart = gp.buttons.map((b) => b.pressed)
    this.live = 0
    this.liveAxis = -1
  }

  /** Sample the device; returns the button pressed this frame during a button step, else -1. */
  sample(gp: Gamepad): number {
    for (let i = 0; i < gp.axes.length; i++) {
      const v = gp.axes[i]
      const s = this.stats[i] ?? (this.stats[i] = { rest: v, min: v, max: v })
      s.min = Math.min(s.min, v)
      s.max = Math.max(s.max, v)
    }
    const best = this.mostTravelled()
    this.liveAxis = best
    if (best >= 0) {
      const s = this.stats[best]
      this.live = s.max - s.min > 0.05 ? clamp01((gp.axes[best] - s.min) / (s.max - s.min)) : 0
    }
    for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i].pressed && !this.buttonsAtStart[i]) return i
    for (let i = 0; i < gp.buttons.length; i++) this.buttonsAtStart[i] = gp.buttons[i].pressed
    return -1
  }

  private mostTravelled(): number {
    let best = -1, span = 0.25 // ignore jitter
    this.stats.forEach((s, i) => { const d = s.max - s.min; if (d > span) { span = d; best = i } })
    return best
  }

  /** Commit the current step from what was sampled; returns false if nothing usable was seen. */
  commit(gp: Gamepad, button = -1): boolean {
    const p = this.profile
    if (this.step === 'steer' || this.step === 'throttle' || this.step === 'brake') {
      const axis = this.mostTravelled()
      if (axis < 0) return false
      const s = this.stats[axis]
      if (this.step === 'steer') {
        p.steer = { axis, min: s.min, max: s.max }
      } else {
        // A pedal rests at one extreme: the rest value is `min`, the far end `max`.
        const rest = s.rest
        const far = Math.abs(s.max - rest) > Math.abs(s.min - rest) ? s.max : s.min
        p[this.step] = { axis, min: rest, max: far }
      }
    } else if (this.step !== 'done') {
      if (button < 0) return false
      p.buttons[this.step] = button
    }
    const i = CALIBRATION_STEPS.indexOf(this.step)
    this.step = CALIBRATION_STEPS[Math.min(CALIBRATION_STEPS.length - 1, i + 1)]
    if (this.step === 'done') p.calibrated = true
    this.begin(gp)
    return true
  }

  skip(gp: Gamepad): void {
    const i = CALIBRATION_STEPS.indexOf(this.step)
    this.step = CALIBRATION_STEPS[Math.min(CALIBRATION_STEPS.length - 1, i + 1)]
    if (this.step === 'done') this.profile.calibrated = true
    this.begin(gp)
  }
}
