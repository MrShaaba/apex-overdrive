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
  /** Distinguishes identical controllers while retaining legacy ID assignments. */
  key: string
  profile: DeviceProfile
  /** Player (0/1) currently fed by this device, or -1. */
  player: number
  role: 'primary' | 'pedals' | null
}

import { bus } from '../core/EventBus'
import { clamp, damp } from '../core/MathUtils'
import { defaultProfile, readDevice, type DeviceProfile, type RawInput } from './Gamepads'

export interface InputState {
  steer: number
  /** Physical wheel: use full steering lock and direct response. */
  directSteering: boolean
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

const emptyState = (): InputState => ({ steer: 0, directSteering: false, throttle: 0, brake: 0, handbrake: false, boost: false, lookBack: false, cameraOrbitX: 0, cameraOrbitY: 0 })

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
  private pedalAssignments: [string | null, string | null] = [null, null]
  private lastActiveDevices = new Map<number, string>()
  private readonly lastPressed = new Map<number, Record<string, boolean>>()
  private steerTargets = [0, 0]
  /** While the calibration screen is sampling a device its buttons must not fire actions. */
  private actionsMuted = false
  private actionReleasePending = new Set<number>()
  get muteActions(): boolean { return this.actionsMuted }
  set muteActions(muted: boolean) {
    if (this.actionsMuted && !muted) {
      // A button that saved a mapping must not immediately pause/reset the race.
      for (const index of this.pads.keys()) this.actionReleasePending.add(index)
    }
    this.actionsMuted = muted
  }
  private pointerDown = false
  private lastPointer = { x: 0, y: 0 }
  private orbitVelocity = [{ x: 0, y: 0 }, { x: 0, y: 0 }]
  private pointerElement: HTMLElement | null = null

  constructor() {
    if (typeof window === 'undefined') return
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('gamepadconnected', this.onConnected)
    window.addEventListener('gamepaddisconnected', this.onDisconnected)
    window.addEventListener('deviceorientation', this.onOrientation)
  }

  configure(opts: { sensitivity?: number; deadzone?: number; tilt?: boolean; tiltSensitivity?: number; devices?: Record<string, DeviceProfile>; players?: [string | null, string | null]; pedals?: [string | null, string | null] }): void {
    if (opts.sensitivity !== undefined) this.steeringSensitivity = opts.sensitivity
    if (opts.deadzone !== undefined) this.deadzone = opts.deadzone
    if (opts.tilt !== undefined) this.tiltEnabled = opts.tilt
    if (opts.tiltSensitivity !== undefined) this.tiltSensitivity = opts.tiltSensitivity
    if (opts.devices !== undefined) this.profiles = opts.devices
    if (opts.players !== undefined) this.assignments = [opts.players[0], opts.players[1]]
    if (opts.pedals !== undefined) this.pedalAssignments = [opts.pedals[0], opts.pedals[1]]
  }

  /** Profile for a device id: the saved calibration, else a default for the device type. */
  profileFor(id: string, key = id): DeviceProfile {
    const base = defaultProfile(id)
    const saved = this.profiles[key] ?? this.profiles[id]
    return saved ? { ...base, ...saved, buttons: { ...base.buttons, ...saved.buttons } } : base
  }

  /** Every connected gamepad with the player it currently feeds. */
  listDevices(): ConnectedDevice[] {
    this.pollPads()
    const out: ConnectedDevice[] = []
    for (const { index, id, key } of this.deviceEntries()) {
      const primary = this.deviceIndexFor(0) === index ? 0 : this.deviceIndexFor(1) === index ? 1 : -1
      const pedals = this.pedalDeviceIndexFor(0) === index ? 0 : this.pedalDeviceIndexFor(1) === index ? 1 : -1
      out.push({ index, id, key, profile: this.profileFor(id, key), player: primary >= 0 ? primary : pedals, role: primary >= 0 ? 'primary' : pedals >= 0 ? 'pedals' : null })
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
    const connected = new Set<number>()
    for (const gp of pads) {
      if (!gp || gp.connected === false) continue
      connected.add(gp.index)
      this.pads.set(gp.index, gp.id)
    }
    for (const index of this.pads.keys()) if (!connected.has(index)) {
      this.pads.delete(index)
      this.lastPressed.delete(index)
    }
  }

  private deviceEntries(): { index: number; id: string; key: string }[] {
    // Browser index stays stable when a different wheel is unplugged. Recomputing
    // ordinals would silently reassign wheel 2 to player 1 on disconnect.
    return [...this.pads.entries()].sort((a, b) => a[0] - b[0]).map(([index, id]) => ({ index, id, key: `${id}::index:${index}` }))
  }

  /** Resolve both players together so an explicit assignment always wins over auto. */
  private primaryIndexes(): [number, number] {
    const entries = this.deviceEntries()
    const reserved = new Set(this.pedalAssignments.filter(Boolean))
    const available = entries.filter((e) => !reserved.has(e.key) && !reserved.has(e.id) && this.profileFor(e.id, e.key).kind !== 'pedals')
    const selected: [number, number] = [-1, -1]
    for (const player of [0, 1] as const) {
      const want = this.assignments[player]
      if (want && want !== KEYBOARD_DEVICE) {
        const hit = available.find((e) => (e.key === want || e.id === want) && !selected.includes(e.index))
        if (hit) selected[player] = hit.index
      }
    }
    for (const player of [0, 1] as const) {
      if (this.assignments[player] !== null) continue
      selected[player] = available.find((e) => !selected.includes(e.index))?.index ?? -1
    }
    return selected
  }

  private deviceIndexFor(player: number): number { return this.primaryIndexes()[player] ?? -1 }

  private pedalDeviceIndexFor(player: number): number {
    const want = this.pedalAssignments[player]
    if (!want || (player === 1 && want === this.pedalAssignments[0])) return -1
    const primary = this.primaryIndexes()
    return this.deviceEntries().find((e) => (e.key === want || e.id === want) && !primary.includes(e.index))?.index ?? -1
  }

  private onBlur = (): void => { this.keys.clear(); this.pointerDown = false }
  private onConnected = (e: GamepadEvent): void => {
    this.pads.set(e.gamepad.index, e.gamepad.id)
    const kind = this.profileFor(e.gamepad.id).kind
    bus.emit('ui:toast', { text: `${kind === 'wheel' ? 'Wheel' : kind === 'pedals' ? 'Pedals' : 'Controller'} connected: ${e.gamepad.id.slice(0, 32)}`, icon: '🎮' })
  }
  private onDisconnected = (e: GamepadEvent): void => {
    this.pads.delete(e.gamepad.index)
    this.lastPressed.delete(e.gamepad.index)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.keys.clear()
      for (const s of this.states) Object.assign(s, emptyState())
    }
  }

  isKeyDown(code: string): boolean {
    return this.keys.has(code)
  }

  /** Attach camera-orbit pointer handling to the game canvas. */
  attachPointer(el: HTMLElement): void {
    this.pointerElement?.removeEventListener('pointerdown', this.onPointerDown)
    this.pointerElement = el
    el.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
  }
  private onPointerDown = (e: PointerEvent): void => {
    if ((e.target as HTMLElement).closest('[data-touch-control]')) return
    this.pointerDown = true
    this.lastPointer = { x: e.clientX, y: e.clientY }
  }
  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointerDown) return
    this.orbitVelocity[0].x += (e.clientX - this.lastPointer.x) * 0.004
    this.orbitVelocity[0].y += (e.clientY - this.lastPointer.y) * 0.004
    this.lastPointer = { x: e.clientX, y: e.clientY }
  }
  private onPointerUp = (): void => { this.pointerDown = false }

  private onKeyDown = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'SELECT') return
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault()
    if (this.keys.has(e.code)) return
    this.keys.add(e.code)
    const action = KEY_ACTIONS[e.code]
    if (action && !this.muteActions) bus.emit('input:action', { action, pressed: true, player: this.keyboardPlayer() })
    if (e.code === 'Backspace' && !this.muteActions) bus.emit('input:action', { action: 'back', pressed: true, player: this.keyboardPlayer() })
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
    const action = KEY_ACTIONS[e.code]
    if (action && !this.muteActions) bus.emit('input:action', { action, pressed: false, player: this.keyboardPlayer() })
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
    const profile = this.profileFor(gp.id, `${gp.id}::index:${index}`)
    const raw = readDevice(gp, profile, this.deadzone)
    let last = this.lastPressed.get(index)
    if (!last) this.lastPressed.set(index, (last = {}))
    if (this.actionReleasePending.has(index) && !Object.values(raw.pressed).some(Boolean)) this.actionReleasePending.delete(index)
    const suppressActions = this.muteActions || this.actionReleasePending.has(index)
    for (const key of ['pause', 'camera', 'reset', 'gearUp', 'gearDown'] as const) {
      const pressed = raw.pressed[key]
      if (pressed && !last[key] && !suppressActions) bus.emit('input:action', { action: key, pressed: true, player })
      last[key] = pressed
    }
    if (profile.kind === 'pad' && this.enabled) {
      // Right stick orbits the camera on pads; wheels have no second stick.
      const axis = (v: number) => (Math.abs(v) < this.deadzone ? 0 : v)
      this.orbitVelocity[player].x += axis(gp.axes[2] ?? 0) * 0.05
      this.orbitVelocity[player].y += axis(gp.axes[3] ?? 0) * 0.05
    }
    return raw
  }

  /** Called once per render frame; updates every player and returns player 1's state. */
  update(dt: number): InputState {
    this.pollPads()
    let disconnected = false
    for (const [index, id] of this.lastActiveDevices) {
      const gp = this.gamepad(index)
      if (!gp || gp.connected === false || gp.id !== id) disconnected = true
    }
    this.lastActiveDevices.clear()
    for (let p = 0; p < this.states.length; p++) {
      for (const index of [this.deviceIndexFor(p), this.pedalDeviceIndexFor(p)]) {
        const gp = index >= 0 ? this.gamepad(index) : null
        if (gp) this.lastActiveDevices.set(index, gp.id)
      }
    }
    if (disconnected) {
      for (const s of this.states) Object.assign(s, emptyState())
      bus.emit('ui:toast', { text: 'Driving controller disconnected. Reconnect it and resume when ready.', icon: '🎮' })
      if (this.enabled && !this.muteActions) bus.emit('input:action', { action: 'controllerDisconnected', pressed: true, player: 0 })
    }
    for (let p = 0; p < this.states.length; p++) this.updatePlayer(p, dt)
    return this.state
  }

  /** Player state (0 = player 1). */
  getState(player: number): InputState {
    return this.states[player] ?? this.state
  }

  private updatePlayer(player: number, dt: number): void {
    const s = this.states[player]
    // Keep action edges alive while paused: the same button must also resume.
    const gp = this.readPlayerDevice(player)
    if (!this.enabled) {
      Object.assign(s, emptyState())
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

    const pedalIndex = this.pedalDeviceIndexFor(player)
    const pedalDevice = pedalIndex >= 0 ? this.gamepad(pedalIndex) : null
    if (this.pedalAssignments[player]) {
      const pedals = pedalDevice ? readDevice(pedalDevice, this.profileFor(pedalDevice.id, `${pedalDevice.id}::index:${pedalIndex}`), this.deadzone) : null
      // The separate pedal set owns pedals; wheel-base defaults must not hold the brake on.
      throttle = Math.max(this.keyboardPlayer() === player && (k.has('ArrowUp') || k.has('KeyW')) ? 1 : 0, pedals?.throttle ?? 0)
      brake = Math.max(this.keyboardPlayer() === player && (k.has('ArrowDown') || k.has('KeyS')) ? 1 : 0, pedals?.brake ?? 0)
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
    s.directSteering = gp?.directSteering ?? false
    s.steer = s.directSteering ? this.steerTargets[player] : damp(s.steer, this.steerTargets[player], rate, dt)
    s.throttle = s.directSteering || pedalDevice ? throttle : damp(s.throttle, throttle, 14, dt)
    s.brake = s.directSteering || pedalDevice ? brake : damp(s.brake, brake, 16, dt)
    s.handbrake = handbrake
    s.boost = boost
    s.lookBack = lookBack

    s.cameraOrbitX = this.orbitVelocity[player].x
    s.cameraOrbitY = this.orbitVelocity[player].y
    this.orbitVelocity[player].x = damp(this.orbitVelocity[player].x, 0, 10, dt)
    this.orbitVelocity[player].y = damp(this.orbitVelocity[player].y, 0, 10, dt)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('deviceorientation', this.onOrientation)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('gamepadconnected', this.onConnected)
    window.removeEventListener('gamepaddisconnected', this.onDisconnected)
    this.pointerElement?.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
  }
}
