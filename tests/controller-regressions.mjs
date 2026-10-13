/** Pure input regressions. No physical hardware or GPU is needed. */
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const checks = []
const check = (name, fn) => { fn(); checks.push(name); console.log(`PASS ${name}`) }
const close = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`)
const device = (index, id, axes = [0, 0, 0, 0]) => ({ index, id, connected: true, mapping: '', timestamp: 0, axes: [...axes], buttons: Array.from({ length: 20 }, () => ({ value: 0, pressed: false, touched: false })) })
const press = (gp, button, value) => { gp.buttons[button] = { value, pressed: value > 0.5, touched: value > 0 } }
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
let pads = []
let input
try {
  const { defaultProfile, readDevice, axisTo01, Calibrator } = await server.ssrLoadModule('/src/game/input/Gamepads.ts')
  const { InputManager, KEYBOARD_DEVICE } = await server.ssrLoadModule('/src/game/input/InputManager.ts')
  const { bus } = await server.ssrLoadModule('/src/game/core/EventBus.ts')
  const fakeWindow = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => pads } })
  check('inverted axes and corrupt channel data produce bounded neutral input', () => {
    close(axisTo01(-1, { axis: 0, min: 1, max: -1 }), 1)
    close(axisTo01(1, { axis: 0, min: 1, max: -1 }), 0)
    close(axisTo01(Number.NaN, { axis: 0, min: 1, max: -1 }), 0)
    close(axisTo01(0, { axis: 0, min: 0, max: 0 }), 0)
    const p = defaultProfile('G29'); p.steer = { axis: 0, min: 0, max: 0 }
    close(readDevice(device(0, p.id), p, 0.08).steer, 0)
  })
  check('wheel centre, reversal, response curve and physical full-lock range', () => {
    const p = defaultProfile('G29'); p.steer = { axis: 0, min: -0.9, center: 0.1, max: 0.9 }; p.steeringDeadzone = 0
    const gp = device(0, p.id, [0.1, 0, 1, 1])
    close(readDevice(gp, p, 0.08).steer, 0)
    gp.axes[0] = 0.5; close(readDevice(gp, p, 0.08).steer, 0.5)
    p.steeringLinearity = 2; close(readDevice(gp, p, 0.08).steer, 0.25)
    p.steeringSaturation = 0.5; close(readDevice(gp, p, 0.08).steer, 1)
    p.invertSteering = true; close(readDevice(gp, p, 0.08).steer, -1)
    assert.equal(readDevice(gp, p, 0.08).directSteering, true)
    p.kind = 'pad'; assert.equal(readDevice(gp, p, 0.08).directSteering, false)
  })
  check('calibration accepts analogue button pedals, records end stops and centre', () => {
    const gp = device(0, 'Generic controller')
    const cal = new Calibrator(defaultProfile(gp.id)); cal.begin(gp)
    gp.axes[0] = 1; cal.sample(gp); gp.axes[0] = -1; cal.sample(gp); gp.axes[0] = 0.05; cal.sample(gp)
    assert.equal(cal.commit(gp), true)
    assert.deepEqual(cal.profile.steer, { axis: 0, min: 1, max: -1, center: 0.05 })
    press(gp, 7, 0.85); cal.sample(gp); press(gp, 7, 0); cal.sample(gp); assert.equal(cal.commit(gp), true)
    assert.deepEqual(cal.profile.throttle, { button: 7, min: 0, max: 0.85 })
    press(gp, 6, 1); cal.sample(gp); press(gp, 6, 0); cal.sample(gp); assert.equal(cal.commit(gp), true)
    assert.equal(cal.profile.brake.button, 6)
    while (cal.step !== 'done') cal.skip(gp)
    assert.equal(cal.profile.calibrated, true)
    press(gp, 7, 0.85); close(readDevice(gp, cal.profile, 0).throttle, 1)
  })
  check('skipped calibration is honest; buttons produce one edge; binding is exclusive', () => {
    const gp = device(0, 'G29')
    const cal = new Calibrator(defaultProfile(gp.id)); cal.begin(gp)
    while (cal.step !== 'gearUp') cal.skip(gp)
    press(gp, 0, 1); assert.equal(cal.sample(gp), 0); assert.equal(cal.sample(gp), -1)
    cal.commit(gp, 0); assert.equal(cal.profile.buttons.gearUp, 0); assert.equal(cal.profile.buttons.boost, -1)
    while (cal.step !== 'done') cal.skip(gp)
    assert.equal(cal.profile.calibrated, false)
  })
  const wheel = device(0, 'G29', [0, 0, -1, -1])
  const pedals = device(1, 'USB pedals', [1, 1])
  const pad = device(2, 'Xbox controller')
  const pedalProfile = { ...defaultProfile(pedals.id), kind: 'pedals', throttle: { axis: 0, min: 1, max: -1 }, brake: { axis: 1, min: 1, max: -1 } }
  pads = [wheel, pedals, pad]
  input = new InputManager()
  input.configure({ players: [wheel.id, pad.id], pedals: [pedals.id, null], devices: { [pedals.id]: pedalProfile } })
  check('separate USB pedals override wheel-base pedal channels and never become P2 steering', () => {
    pedals.axes[0] = -1; pedals.axes[1] = 1
    input.update(1 / 60)
    close(input.state.throttle, 1); close(input.state.brake, 0)
    assert.equal(input.listDevices()[1].role, 'pedals')
    pad.axes[0] = -1; input.update(1)
    assert.ok(input.getState(1).steer < -0.9)
    close(input.state.steer, 0)
    assert.equal(input.state.directSteering, true)
  })
  let paused = false
  const unpause = bus.on('input:action', ({ action }) => { if (action === 'pause') { paused = !paused; input.setEnabled(!paused) } })
  check('a wheel can pause and resume with the same button', () => {
    press(wheel, 9, 1); input.update(1 / 60); assert.equal(paused, true); close(input.state.throttle, 0)
    press(wheel, 9, 0); input.update(1 / 60)
    press(wheel, 9, 1); input.update(1 / 60); assert.equal(paused, false); close(input.state.throttle, 1)
    press(wheel, 9, 0); input.update(1 / 60)
  })
  unpause()
  check('saving a binding suppresses the held button until release', () => {
    let pauseEdges = 0
    const off = bus.on('input:action', ({ action }) => { if (action === 'pause') pauseEdges++ })
    input.muteActions = true
    press(wheel, 12, 1); input.update(1 / 60)
    const profile = defaultProfile(wheel.id); profile.buttons.pause = 12
    input.configure({ devices: { [wheel.id]: profile, [pedals.id]: pedalProfile } })
    input.muteActions = false
    input.update(1 / 60); assert.equal(pauseEdges, 0)
    press(wheel, 12, 0); input.update(1 / 60)
    press(wheel, 12, 1); input.update(1 / 60); assert.equal(pauseEdges, 1)
    press(wheel, 12, 0); input.update(1 / 60)
    off()
  })
  check('disconnecting USB pedals emits one pause request and clears held throttle', () => {
    let disconnects = 0
    const off = bus.on('input:action', ({ action }) => { if (action === 'controllerDisconnected') { disconnects++; input.setEnabled(false) } })
    pads[1] = null; input.update(1 / 60); close(input.state.throttle, 0); assert.equal(disconnects, 1)
    input.update(1 / 60); assert.equal(disconnects, 1)
    pads[1] = pedals; input.update(1 / 60); close(input.state.throttle, 0)
    off(); input.setEnabled(true)
    pads[1] = null; input.update(1 / 60)
    close(input.state.throttle, 0); close(input.state.brake, 0)
    pads[1] = pedals; input.update(1 / 60)
  })
  check('identical controller IDs can be assigned to different players', () => {
    input.dispose()
    pads = [device(0, 'Identical pad', [0.8, 0, 0, 0]), device(1, 'Identical pad', [-0.8, 0, 0, 0])]
    input = new InputManager()
    const entries = input.listDevices()
    assert.notEqual(entries[0].key, entries[1].key)
    input.configure({ players: [entries[0].key, entries[1].key] }); input.update(1)
    assert.ok(input.state.steer > 0.7); assert.ok(input.getState(1).steer < -0.7)
    input.configure({ players: [KEYBOARD_DEVICE, null] }); input.update(1)
    close(input.state.steer, 0, 0.001); assert.ok(input.getState(1).steer > 0.7)
  })
  check('same-ID wheel profiles and P2 routing survive P1 disconnect and input reload', () => {
    input.dispose()
    pads = [device(0, 'Logitech G29', [0.4, 0, -1, 1]), device(1, 'Logitech G29', [-0.4, 0, 1, -1])]
    input = new InputManager()
    const entries = input.listDevices()
    const first = defaultProfile(pads[0].id), second = defaultProfile(pads[1].id)
    first.steeringLinearity = 1; second.steeringLinearity = 2
    first.buttons.camera = 3; second.buttons.camera = 12
    const config = { players: entries.map((e) => e.key), devices: { [entries[0].key]: first, [entries[1].key]: second } }
    input.configure(config); input.update(1)
    close(input.state.throttle, 1); close(input.getState(1).brake, 1)
    assert.ok(input.state.steer > 0.3 && input.getState(1).steer > -0.2)
    const firstWheel = pads[0]
    pads[0] = null; input.update(1)
    assert.deepEqual(input.listDevices().map((d) => [d.key, d.player]), [[entries[1].key, 1]])
    input.dispose(); input = new InputManager(); input.configure(config); input.update(1)
    assert.deepEqual(input.listDevices().map((d) => [d.key, d.player]), [[entries[1].key, 1]])
    pads[0] = firstWheel; input.update(1)
    assert.deepEqual(input.listDevices().map((d) => d.player), [0, 1])
    assert.equal(input.listDevices()[1].profile.buttons.camera, 12)
    assert.equal(input.listDevices()[0].profile.buttons.camera, 3)
  })
  check('unknown hardware explicitly set to wheel has no face-button acceleration', () => {
    const gp = device(0, 'Unlisted F1 wheel', [0, 0, 0, 0]); press(gp, 0, 1)
    const profile = defaultProfile(gp.id); profile.kind = 'wheel'; profile.throttle = { button: 7 }; profile.brake = { button: 6 }
    const out = readDevice(gp, profile, 0.08)
    close(out.faceThrottle, 0); close(out.throttle, 0); assert.equal(out.pressed.boost, false)
  })
  console.log(`Controller regressions: ${checks.length} passed (synthetic devices; no hardware compatibility claim).`)
} finally {
  input?.dispose()
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor); else delete globalThis.window
  await server.close()
}
