/**
 * Unified input: keyboard, gamepad, touch overlay and device tilt.
 *
 * Produces a normalized `InputState` every frame (steer -1..1, throttle 0..1,
 * brake 0..1, handbrake, boost) plus edge-triggered actions on the event bus
 * (camera cycle, pause, reset, gear up/down, photo mode, ...). Digital keyboard
 * steering is smoothed so it feels like an analog stick.
 */

import { bus } from '../core/EventBus'
import { clamp, damp } from '../core/MathUtils'

export interface InputState {
  steer: number
  throttle: number
  brake: number
  handbrake: boolean
  boost: boolean
  lookBack: boolean
  cameraOrbitX: number
  cameraOrbitY: number
}

export type InputAction =
  | 'pause'
  | 'camera'
  | 'reset'
  | 'gearUp'
  | 'gearDown'
  | 'photo'
  | 'replay'
  | 'horn'
  | 'headlights'
  | 'confirm'
  | 'back'
  | 'leaderboard'
  | 'toggleHud'
  | 'colliderDebug'

const KEY_ACTIONS: Record<string, InputAction> = {
  Escape: 'pause',
  KeyP: 'pause',
  KeyC: 'camera',
  KeyR: 'reset',
  KeyE: 'gearUp',
  KeyQ: 'gearDown',
  KeyF: 'photo',
  KeyV: 'replay',
  KeyH: 'horn',
  KeyL: 'headlights',
  F3: 'colliderDebug',
  Enter: 'confirm',
  Tab: 'leaderboard',
  KeyN: 'toggleHud',
}

export class InputManager {
  readonly state: InputState = {
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: false,
    boost: false,
    lookBack: false,
    cameraOrbitX: 0,
    cameraOrbitY: 0,
  }

  private readonly keys = new Set<string>()
  private steerTarget = 0
  private enabled = true
  private steeringSensitivity = 1
  private deadzone = 0.08

  /** Values pushed from the touch overlay component. */
  readonly touch = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false, active: false }
  /** Device orientation tilt in [-1, 1]. */
  private tilt = 0
  private tiltEnabled = false
  private tiltSensitivity = 1
  private gamepadIndex: number | null = null
  private lastButtons: boolean[] = []
  private pointerDown = false
  private lastPointer = { x: 0, y: 0 }
  private orbitVelocity = { x: 0, y: 0 }

  constructor() {
    if (typeof window === 'undefined') return
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', () => this.keys.clear())
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index
      bus.emit('ui:toast', { text: `Controller connected: ${e.gamepad.id.slice(0, 24)}`, icon: '🎮' })
    })
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = null
    })
    window.addEventListener('deviceorientation', this.onOrientation)
  }

  configure(opts: { sensitivity?: number; deadzone?: number; tilt?: boolean; tiltSensitivity?: number }): void {
    if (opts.sensitivity !== undefined) this.steeringSensitivity = opts.sensitivity
    if (opts.deadzone !== undefined) this.deadzone = opts.deadzone
    if (opts.tilt !== undefined) this.tiltEnabled = opts.tilt
    if (opts.tiltSensitivity !== undefined) this.tiltSensitivity = opts.tiltSensitivity
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.keys.clear()
      this.state.throttle = 0
      this.state.brake = 0
      this.state.handbrake = false
      this.state.boost = false
    }
  }

  isKeyDown(code: string): boolean {
    return this.keys.has(code)
  }

  /** Attach camera-orbit pointer handling to the game canvas. */
  attachPointer(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('[data-touch-control]')) return
      this.pointerDown = true
      this.lastPointer = { x: e.clientX, y: e.clientY }
    })
    window.addEventListener('pointermove', (e) => {
      if (!this.pointerDown) return
      const dx = e.clientX - this.lastPointer.x
      const dy = e.clientY - this.lastPointer.y
      this.lastPointer = { x: e.clientX, y: e.clientY }
      this.orbitVelocity.x += dx * 0.004
      this.orbitVelocity.y += dy * 0.004
    })
    window.addEventListener('pointerup', () => (this.pointerDown = false))
    window.addEventListener('pointercancel', () => (this.pointerDown = false))
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault()
    if (this.keys.has(e.code)) return
    this.keys.add(e.code)
    const action = KEY_ACTIONS[e.code]
    if (action) bus.emit('input:action', { action, pressed: true })
    if (e.code === 'Backspace') bus.emit('input:action', { action: 'back', pressed: true })
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
    const action = KEY_ACTIONS[e.code]
    if (action) bus.emit('input:action', { action, pressed: false })
  }

  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (!this.tiltEnabled) return
    // Landscape: gamma is roll; portrait: beta. Prefer gamma (landscape gaming).
    const landscape = window.innerWidth > window.innerHeight
    const raw = landscape ? (e.beta ?? 0) : (e.gamma ?? 0)
    const sign = landscape && (window.screen.orientation?.angle ?? 0) === 270 ? -1 : 1
    this.tilt = clamp((raw / 25) * this.tiltSensitivity * sign, -1, 1)
  }

  private readGamepad(): { steer: number; throttle: number; brake: number; hb: boolean; boost: boolean; lookBack: boolean } | null {
    if (this.gamepadIndex === null || typeof navigator.getGamepads !== 'function') return null
    const gp = navigator.getGamepads()[this.gamepadIndex]
    if (!gp) return null
    const axis = (v: number) => (Math.abs(v) < this.deadzone ? 0 : v)
    const steer = axis(gp.axes[0] ?? 0)
    const rt = gp.buttons[7]?.value ?? 0
    const lt = gp.buttons[6]?.value ?? 0
    const a = gp.buttons[0]?.pressed ?? false
    const x = gp.buttons[2]?.pressed ?? false
    const b = gp.buttons[1]?.pressed ?? false
    const y = gp.buttons[3]?.pressed ?? false
    const lb = gp.buttons[4]?.pressed ?? false
    const rb = gp.buttons[5]?.pressed ?? false
    const start = gp.buttons[9]?.pressed ?? false
    const select = gp.buttons[8]?.pressed ?? false
    const edge = (i: number, pressed: boolean, action: InputAction) => {
      if (pressed && !this.lastButtons[i]) bus.emit('input:action', { action, pressed: true })
      this.lastButtons[i] = pressed
    }
    edge(9, start, 'pause')
    edge(3, y, 'camera')
    edge(8, select, 'reset')
    edge(5, rb, 'gearUp')
    edge(4, lb, 'gearDown')
    const orbitX = axis(gp.axes[2] ?? 0)
    const orbitY = axis(gp.axes[3] ?? 0)
    this.orbitVelocity.x += orbitX * 0.05
    this.orbitVelocity.y += orbitY * 0.05
    return { steer, throttle: Math.max(rt, a ? 1 : 0), brake: Math.max(lt, x ? 1 : 0), hb: b, boost: gp.buttons[10]?.pressed || (gp.axes[1] ?? 0) < -0.7, lookBack: (gp.axes[1] ?? 0) > 0.7 }
  }

  /** Called once per render frame. */
  update(dt: number): InputState {
    const s = this.state
    if (!this.enabled) {
      s.steer = damp(s.steer, 0, 8, dt)
      s.throttle = 0
      s.brake = 0
      return s
    }

    const k = this.keys
    let steer = 0
    let throttle = 0
    let brake = 0
    let handbrake = false
    let boost = false
    let lookBack = false
    let analogSteer = false

    if (k.has('ArrowLeft') || k.has('KeyA')) steer -= 1
    if (k.has('ArrowRight') || k.has('KeyD')) steer += 1
    if (k.has('ArrowUp') || k.has('KeyW')) throttle = 1
    if (k.has('ArrowDown') || k.has('KeyS')) brake = 1
    if (k.has('Space')) handbrake = true
    if (k.has('ShiftLeft') || k.has('ShiftRight')) boost = true
    if (k.has('KeyB')) lookBack = true

    const gp = this.readGamepad()
    if (gp) {
      if (Math.abs(gp.steer) > 0) {
        steer = gp.steer
        analogSteer = true
      }
      throttle = Math.max(throttle, gp.throttle)
      brake = Math.max(brake, gp.brake)
      handbrake = handbrake || gp.hb
      boost = boost || gp.boost
      lookBack = lookBack || gp.lookBack
    }

    if (this.touch.active) {
      if (this.tiltEnabled) {
        steer = this.tilt
        analogSteer = true
      } else if (this.touch.steer !== 0) {
        steer = this.touch.steer
        analogSteer = Math.abs(this.touch.steer) < 0.999
      }
      throttle = Math.max(throttle, this.touch.throttle)
      brake = Math.max(brake, this.touch.brake)
      handbrake = handbrake || this.touch.handbrake
      boost = boost || this.touch.boost
    }

    // Digital steering is ramped; analog steering is direct with light smoothing.
    this.steerTarget = clamp(steer * this.steeringSensitivity, -1, 1)
    const rate = analogSteer ? 18 : steer === 0 ? 10 : 5.5
    s.steer = damp(s.steer, this.steerTarget, rate, dt)
    s.throttle = damp(s.throttle, throttle, 14, dt)
    s.brake = damp(s.brake, brake, 16, dt)
    s.handbrake = handbrake
    s.boost = boost
    s.lookBack = lookBack

    s.cameraOrbitX = this.orbitVelocity.x
    s.cameraOrbitY = this.orbitVelocity.y
    this.orbitVelocity.x = damp(this.orbitVelocity.x, 0, 10, dt)
    this.orbitVelocity.y = damp(this.orbitVelocity.y, 0, 10, dt)
    return s
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('deviceorientation', this.onOrientation)
  }
}
