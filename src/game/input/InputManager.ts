/**
 * Unified input: keyboard, gamepad, touch overlay and device tilt.
 *
 * Produces a normalized `InputState` every frame (steer -1..1, throttle 0..1,
 * brake 0..1, handbrake, boost) plus edge-triggered actions on the event bus
 * (camera cycle, pause, reset, gear up/down, photo mode, ...). Digital keyboard
 * steering is smoothed so it feels like an analog stick.
 *
 * Several gamepads / racing wheels can be connected at once; each is read through
 * its DeviceProfile (see Gamepads.ts) and feeds one player. Player 1 also gets the
 * keyboard, touch overlay and tilt; player 2 gets only its assigned device, or the
 * keyboard when it is assigned the 'keyboard' pseudo-device. Actions on the bus
 * carry the player index that raised them.
 */

export const KEYBOARD_DEVICE = 'keyboard'

export interface ConnectedDevice {
  index: number
  id: string
  profile: DeviceProfile
  /** Player (0/1) currently fed by this device, or -1. */
  player: number
}

import { bus } from '../core/EventBus'
import { clamp, damp } from '../core/MathUtils'
import { defaultProfile, readDevice, type DeviceProfile, type RawInput } from './Gamepads'

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

const emptyState = (): InputState => ({ steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false, lookBack: false, cameraOrbitX: 0, cameraOrbitY: 0 })

export class InputManager {
  /** Player 1 state (kept as `state` for the existing single-player call sites). */
  readonly state: InputState = emptyState()
  /** Per-player states: index 0 is `state`. */
  readonly states: InputState[] = [this.state, emptyState()]

  private readonly keys = new Set<string>()
  private enabled = true
  private steeringSensitivity = 1
  private deadzone = 0.08

  /** Values pushed from the touch overlay component. */
  readonly touch = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false, active: false }
  /** Device orientation tilt in [-1, 1]. */
  private tilt = 0
  private tiltEnabled = false
  private tiltSensitivity = 1
  /** Connected gamepads by index (Gamepad objects are re-read every frame). */
  private readonly pads = new Map<number, string>()
  private profiles: Record<string, DeviceProfile> = {}
  private assignments: [string | null, string | null] = [null, null]
  private readonly lastPressed = new Map<number, Record<string, boolean>>()
  private steerTargets = [0, 0]
  /** While the calibration screen is sampling a device its buttons must not fire actions. */
  muteActions = false
  private pointerDown = false
  private lastPointer = { x: 0, y: 0 }
  private orbitVelocity = { x: 0, y: 0 }

  constructor() {
    if (typeof window === 'undefined') return
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', () => this.keys.clear())
    window.addEventListener('gamepadconnected', (e) => {
      this.pads.set(e.gamepad.index, e.gamepad.id)
      const kind = this.profileFor(e.gamepad.id).kind
      bus.emit('ui:toast', { text: `${kind === 'wheel' ? 'Wheel' : 'Controller'} connected: ${e.gamepad.id.slice(0, 24)}`, icon: kind === 'wheel' ? '🏎️' : '🎮' })
    })
    window.addEventListener('gamepaddisconnected', (e) => {
      this.pads.delete(e.gamepad.index)
      this.lastPressed.delete(e.gamepad.index)
    })
    window.addEventListener('deviceorientation', this.onOrientation)
  }

  configure(opts: { sensitivity?: number; deadzone?: number; tilt?: boolean; tiltSensitivity?: number; devices?: Record<string, DeviceProfile>; players?: [string | null, string | null] }): void {
    if (opts.sensitivity !== undefined) this.steeringSensitivity = opts.sensitivity
    if (opts.deadzone !== undefined) this.deadzone = opts.deadzone
    if (opts.tilt !== undefined) this.tiltEnabled = opts.tilt
    if (opts.tiltSensitivity !== undefined) this.tiltSensitivity = opts.tiltSensitivity
    if (opts.devices !== undefined) this.profiles = opts.devices
    if (opts.players !== undefined) this.assignments = [opts.players[0], opts.players[1]]
  }

  /** Profile for a device id: the saved calibration, else a default for the device type. */
  profileFor(id: string): DeviceProfile {
    return this.profiles[id] ?? defaultProfile(id)
  }

  /** Every connected gamepad with the player it currently feeds. */
  listDevices(): ConnectedDevice[] {
    this.pollPads()
    const out: ConnectedDevice[] = []
    for (const [index, id] of this.pads) {
      const player = this.deviceIndexFor(0) === index ? 0 : this.deviceIndexFor(1) === index ? 1 : -1
      out.push({ index, id, profile: this.profileFor(id), player })
    }
    return out.sort((a, b) => a.index - b.index)
  }

  /** Whether the keyboard drives the given player. */
  keyboardPlayer(): number {
    return this.assignments[1] === KEYBOARD_DEVICE ? 1 : 0
  }

  /** Raw Gamepad for a connected index (for the calibration screen). */
  gamepad(index: number): Gamepad | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null
    return navigator.getGamepads()[index] ?? null
  }

  /** Some browsers only surface pads through getGamepads() until the first button press. */
  private pollPads(): void {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return
    const pads = navigator.getGamepads()
    for (let i = 0; i < pads.length; i++) {
      const gp = pads[i]
      if (gp && !this.pads.has(gp.index)) this.pads.set(gp.index, gp.id)
      if (!gp && this.pads.has(i)) this.pads.delete(i)
    }
  }

  /**
   * Gamepad index feeding a player: the assigned device id when connected, otherwise
   * the first (player 1) or second (player 2) connected pad not claimed by the other
   * player, so two pads work without visiting the options screen.
   */
  private deviceIndexFor(player: number): number {
    const want = this.assignments[player]
    if (want === KEYBOARD_DEVICE) return -1
    const ids = [...this.pads.entries()].sort((a, b) => a[0] - b[0])
    if (want) {
      const hit = ids.find(([, id]) => id === want)
      if (hit) return hit[0]
      return -1
    }
    const other = this.assignments[1 - player]
    const free = ids.filter(([, id]) => id !== other || other === null)
    // Player 1 takes the first free pad, player 2 the next one.
    const pick = free[player === 0 ? 0 : this.assignments[0] ? 0 : 1]
    return pick ? pick[0] : -1
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.keys.clear()
      for (const s of this.states) {
        s.throttle = 0
        s.brake = 0
        s.handbrake = false
        s.boost = false
      }
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
    if (action) bus.emit('input:action', { action, pressed: true, player: this.keyboardPlayer() })
    if (e.code === 'Backspace') bus.emit('input:action', { action: 'back', pressed: true, player: this.keyboardPlayer() })
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
    const action = KEY_ACTIONS[e.code]
    if (action) bus.emit('input:action', { action, pressed: false, player: this.keyboardPlayer() })
  }

  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (!this.tiltEnabled) return
    // Landscape: gamma is roll; portrait: beta. Prefer gamma (landscape gaming).
    const landscape = window.innerWidth > window.innerHeight
    const raw = landscape ? (e.beta ?? 0) : (e.gamma ?? 0)
    const sign = landscape && (window.screen.orientation?.angle ?? 0) === 270 ? -1 : 1
    this.tilt = clamp((raw / 25) * this.tiltSensitivity * sign, -1, 1)
  }

  private readPlayerDevice(player: number): RawInput | null {
    const index = this.deviceIndexFor(player)
    if (index < 0) return null
    const gp = this.gamepad(index)
    if (!gp) return null
    const profile = this.profileFor(gp.id)
    const raw = readDevice(gp, profile, this.deadzone)
    let last = this.lastPressed.get(index)
    if (!last) this.lastPressed.set(index, (last = {}))
    for (const key of ['pause', 'camera', 'reset', 'gearUp', 'gearDown'] as const) {
      const pressed = raw.pressed[key]
      if (pressed && !last[key] && !this.muteActions) bus.emit('input:action', { action: key, pressed: true, player })
      last[key] = pressed
    }
    if (profile.kind === 'pad') {
      // Right stick orbits the camera on pads; wheels have no second stick.
      const axis = (v: number) => (Math.abs(v) < this.deadzone ? 0 : v)
      this.orbitVelocity.x += axis(gp.axes[2] ?? 0) * 0.05
      this.orbitVelocity.y += axis(gp.axes[3] ?? 0) * 0.05
    }
    return raw
  }

  /** Called once per render frame; updates every player and returns player 1's state. */
  update(dt: number): InputState {
    this.pollPads()
    for (let p = 0; p < this.states.length; p++) this.updatePlayer(p, dt)
    return this.state
  }

  /** Player state (0 = player 1). */
  getState(player: number): InputState {
    return this.states[player] ?? this.state
  }

  private updatePlayer(player: number, dt: number): void {
    const s = this.states[player]
    if (!this.enabled) {
      s.steer = damp(s.steer, 0, 8, dt)
      s.throttle = 0
      s.brake = 0
      return
    }

    const k = this.keys
    let steer = 0
    let throttle = 0
    let brake = 0
    let handbrake = false
    let boost = false
    let lookBack = false
    let analogSteer = false

    if (this.keyboardPlayer() === player) {
      if (k.has('ArrowLeft') || k.has('KeyA')) steer -= 1
      if (k.has('ArrowRight') || k.has('KeyD')) steer += 1
      if (k.has('ArrowUp') || k.has('KeyW')) throttle = 1
      if (k.has('ArrowDown') || k.has('KeyS')) brake = 1
      if (k.has('Space')) handbrake = true
      if (k.has('ShiftLeft') || k.has('ShiftRight')) boost = true
      if (k.has('KeyB')) lookBack = true
    }

    const gp = this.readPlayerDevice(player)
    if (gp) {
      if (Math.abs(gp.steer) > 0) {
        steer = gp.steer
        analogSteer = true
      }
      throttle = Math.max(throttle, gp.throttle, gp.faceThrottle)
      brake = Math.max(brake, gp.brake, gp.faceBrake)
      handbrake = handbrake || gp.pressed.handbrake
      boost = boost || gp.pressed.boost
      lookBack = lookBack || gp.pressed.lookBack
    }

    if (player === 0 && this.touch.active) {
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
    this.steerTargets[player] = clamp(steer * this.steeringSensitivity, -1, 1)
    const rate = analogSteer ? 18 : steer === 0 ? 10 : 5.5
    s.steer = damp(s.steer, this.steerTargets[player], rate, dt)
    s.throttle = damp(s.throttle, throttle, 14, dt)
    s.brake = damp(s.brake, brake, 16, dt)
    s.handbrake = handbrake
    s.boost = boost
    s.lookBack = lookBack

    if (player === 0) {
      s.cameraOrbitX = this.orbitVelocity.x
      s.cameraOrbitY = this.orbitVelocity.y
      this.orbitVelocity.x = damp(this.orbitVelocity.x, 0, 10, dt)
      this.orbitVelocity.y = damp(this.orbitVelocity.y, 0, 10, dt)
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('deviceorientation', this.onOrientation)
  }
}
