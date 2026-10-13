/** Device setup, response tuning and live verification for pads and modular wheel rigs. */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button'
import { Panel, Segmented, Field, Chip, Slider, Toggle } from './Controls'
import { Engine } from '../../game/core/Engine'
import { KEYBOARD_DEVICE, type ConnectedDevice } from '../../game/input/InputManager'
import { Calibrator, CALIBRATION_PROMPT, CALIBRATION_STEPS, BUTTON_LABELS, readDevice, isAxisMap, type CalibrationStep, type DeviceProfile, type DeviceButtons, type ControlMap } from '../../game/input/Gamepads'
import type { Settings } from '../../game/core/Settings'
import './DevicePanel.css'

type Update = (fn: (s: Settings) => void) => void
const shortName = (id: string) => id.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48) || id.slice(0, 48)
const mappingName = (map: ControlMap) => isAxisMap(map) ? `Axis ${map.axis} (${map.min.toFixed(2)} → ${map.max.toFixed(2)})` : `Button ${map.button}`
const actionKeys = Object.keys(BUTTON_LABELS) as (keyof DeviceButtons)[]

export function DevicePanel({ settings, update }: { settings: Settings; update: Update }) {
  const [devices, setDevices] = useState<ConnectedDevice[]>([])
  const [calibrating, setCalibrating] = useState<ConnectedDevice | null>(null)
  const [binding, setBinding] = useState<{ device: ConnectedDevice; action: keyof DeviceButtons } | null>(null)
  useEffect(() => {
    const tick = () => setDevices(Engine.get().input.listDevices())
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [])
  const players = settings.controls.players
  const pedals = settings.controls.pedals ?? [null, null]
  const setDevice = (player: 0 | 1, key: string | null, role: 'players' | 'pedals') => update((s) => {
    s.controls.pedals ??= [null, null]
    s.controls[role][player] = key
    if (!key) return
    for (const group of ['players', 'pedals'] as const) for (const who of [0, 1] as const) {
      if ((group !== role || who !== player) && s.controls[group][who] === key) s.controls[group][who] = null
    }
  })
  const choices = (player: 0 | 1, role: 'players' | 'pedals') => {
    const selected = role === 'players' ? players[player] : pedals[player]
    const options = [
      { value: '', label: role === 'pedals' ? 'Pedals on main device' : player === 0 ? 'Automatic · keyboard + first controller' : 'Automatic · next controller' },
      ...(role === 'players' ? [{ value: KEYBOARD_DEVICE, label: 'Keyboard only' }] : []),
      ...devices.filter((d) => role === 'pedals' || d.profile.kind !== 'pedals').map((d) => ({ value: d.key, label: `${shortName(d.id)} · #${d.index + 1}` })),
    ]
    if (selected && !options.some((o) => o.value === selected)) {
      const legacy = devices.find((d) => d.id === selected)
      if (legacy) { const match = options.find((o) => o.value === legacy.key); if (match) match.value = selected }
      else options.push({ value: selected, label: `${shortName(selected)} · disconnected` })
    }
    return options
  }
  const editProfile = (device: ConnectedDevice, change: (p: DeviceProfile) => void) => update((s) => {
    const profile = structuredClone(s.controls.devices[device.key] ?? device.profile)
    change(profile)
    s.controls.devices[device.key] = profile
  })
  return (
    <Panel title="Wheels & controllers" className="controller-panel">
      <p className="hint" style={{ marginTop: 0 }}>Connect the wheel and pedals, then press a device button. Choose the device type, calibrate, and check the live meters. Separate USB pedals can join either driver's wheel. Setup is saved automatically.</p>
      <p className="hint">For Logitech-style wheel + pedal sets, leave separate pedals on the main device. Use the manufacturer's driver to set wheel rotation. Hardware must be exposed by the browser Gamepad API; wheel force feedback is not implemented.</p>
      {devices.length === 0 && <div className="hint">No controllers detected. Press a button on the device. If it stays absent, check its driver and browser support.</div>}
      <div className="controller-assignments">
        {([0, 1] as const).map((player) => <div key={player}>
          <Field label={`Player ${player + 1} steering / buttons`}>
            <select aria-label={`Player ${player + 1} device`} value={players[player] ?? ''} onChange={(e) => setDevice(player, e.target.value || null, 'players')}>
              {choices(player, 'players').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>

        </div>)}
      </div>
      <details className="controller-tuning">
        <summary>Optional separate USB pedals</summary>
        <div className="controller-assignments">{([0, 1] as const).map((player) => <div key={player}>
          <Field label={`Player ${player + 1} separate pedals`}>
            <select aria-label={`Player ${player + 1} pedals`} value={pedals[player] ?? ''} onChange={(e) => setDevice(player, e.target.value || null, 'pedals')}>
              {choices(player, 'pedals').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        </div>)}</div>
      </details>
      {devices.map((d) => <div key={d.index} className="controller-device">
        <div className="device-row" data-testid="device-row">
          <div className="device-row__info">
            <div className="device-row__name" title={d.id}>{d.profile.kind === 'wheel' ? '🏎️' : d.profile.kind === 'pedals' ? '🦶' : '🎮'} {shortName(d.id)} · #{d.index + 1}</div>
            <div className="device-row__meta">
              <Chip tone={d.profile.calibrated ? 'accent' : undefined}>{d.profile.calibrated ? 'Calibrated' : 'Check calibration'}</Chip>
              {d.player >= 0 && <Chip tone="gold">Player {d.player + 1}{d.role === 'pedals' ? ' pedals' : ''}</Chip>}
            </div>
          </div>
          <div className="device-row__actions">
            <Button size="small" onClick={() => setDevice(0, d.key, d.profile.kind === 'pedals' ? 'pedals' : 'players')} disabled={(d.profile.kind === 'pedals' ? pedals[0] : players[0]) === d.key}>P1</Button>
            <Button size="small" onClick={() => setDevice(1, d.key, d.profile.kind === 'pedals' ? 'pedals' : 'players')} disabled={(d.profile.kind === 'pedals' ? pedals[1] : players[1]) === d.key}>P2</Button>
            <Button size="small" variant="primary" onClick={() => setCalibrating(d)}>Calibrate</Button>
          </div>
        </div>
        <Field label="Device type">
          <Segmented<DeviceProfile['kind']> value={d.profile.kind} options={[{ value: 'pad', label: 'Gamepad' }, { value: 'wheel', label: 'Wheel' }, { value: 'pedals', label: 'Pedals' }]} onChange={(kind) => editProfile(d, (p) => { p.kind = kind; p.calibrated = false })} />
        </Field>
        <details className="controller-tuning">
          <summary>Tune / test controls</summary>
          <DeviceTuning device={d} deadzone={settings.controls.steeringDeadzone} change={(fn) => editProfile(d, fn)} bind={(action) => setBinding({ device: d, action })} />
        </details>
      </div>)}
      {calibrating && <CalibrationOverlay device={calibrating} onSave={(p) => { update((s) => { s.controls.devices[calibrating.key] = p }); setCalibrating(null) }} onCancel={() => setCalibrating(null)} />}
      {binding && <BindingOverlay device={binding.device} action={binding.action} onSave={(button) => {
        editProfile(binding.device, (p) => {
          for (const action of actionKeys) if (p.buttons[action] === button) p.buttons[action] = -1
          p.buttons[binding.action] = button
        })
        setBinding(null)
      }} onCancel={() => setBinding(null)} />}
    </Panel>
  )
}

function DeviceTuning({ device, deadzone, change, bind }: { device: ConnectedDevice; deadzone: number; change: (fn: (p: DeviceProfile) => void) => void; bind: (action: keyof DeviceButtons) => void }) {
  const p = device.profile
  const [live, setLive] = useState({ steer: 0, throttle: 0, brake: 0, axes: [] as number[], buttons: [] as number[], connected: true })
  useEffect(() => {
    const timer = window.setInterval(() => {
      const gp = Engine.get().input.gamepad(device.index)
      if (!gp || gp.id !== device.id) { setLive((l) => ({ ...l, connected: false })); return }
      const input = readDevice(gp, p, deadzone)
      setLive({ steer: input.steer, throttle: input.throttle, brake: input.brake, axes: [...gp.axes], buttons: gp.buttons.map((b, i) => b.pressed ? i : -1).filter((i) => i >= 0), connected: true })
    }, 100)
    return () => window.clearInterval(timer)
  }, [device.index, device.id, p, deadzone])
  const invertPedal = (control: 'throttle' | 'brake') => change((profile) => {
    const m = profile[control]
    if (isAxisMap(m)) [m.min, m.max] = [m.max, m.min]
  })
  return <div className="controller-tuning__body">
    <div className="controller-meters" data-testid="controller-meters">
      {p.kind !== 'pedals' && <Field label="Steering" value={`${Math.round(live.steer * 100)}%`}><meter min={-1} max={1} value={live.steer} aria-label="Steering input" /></Field>}
      <Field label="Throttle" value={`${Math.round(live.throttle * 100)}%`}><meter min={0} max={1} value={live.throttle} aria-label="Throttle input" /></Field>
      <Field label="Brake" value={`${Math.round(live.brake * 100)}%`}><meter min={0} max={1} value={live.brake} aria-label="Brake input" /></Field>
    </div>
    <p className="hint">{live.connected ? `Raw axes: ${live.axes.map((a, i) => `${i}: ${a.toFixed(2)}`).join(' · ') || 'none'} · Pressed buttons: ${live.buttons.join(', ') || 'none'}` : 'Device disconnected.'}</p>
    {p.kind !== 'pedals' && <>
      <p className="hint">Steering: {mappingName(p.steer)} · centre {(p.steer.center ?? (p.steer.min + p.steer.max) / 2).toFixed(2)}. A linear curve (1.00) preserves wheel movement; higher values soften the centre.</p>
      <div className="controller-tune-grid">
        <Field label="Steering deadzone" value={(p.steeringDeadzone ?? (p.kind === 'wheel' ? 0.015 : deadzone)).toFixed(3)}><Slider value={p.steeringDeadzone ?? (p.kind === 'wheel' ? 0.015 : deadzone)} min={0} max={0.3} step={0.005} onChange={(v) => change((q) => { q.steeringDeadzone = v })} /></Field>
        <Field label="Steering curve" value={(p.steeringLinearity ?? 1).toFixed(2)}><Slider value={p.steeringLinearity ?? 1} min={0.5} max={3} step={0.05} onChange={(v) => change((q) => { q.steeringLinearity = v })} /></Field>
        <Field label="Travel to full lock" value={`${Math.round((p.steeringSaturation ?? 1) * 100)}%`}><Slider value={p.steeringSaturation ?? 1} min={0.4} max={1} onChange={(v) => change((q) => { q.steeringSaturation = v })} /></Field>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
        <Toggle value={p.invertSteering ?? false} onChange={(v) => change((q) => { q.invertSteering = v })} label="Invert steering" />
        {p.kind === 'wheel' && <Toggle value={p.directSteering !== false} onChange={(v) => change((q) => { q.directSteering = v })} label="Direct wheel steering (full lock at speed)" />}
        <Button size="small" onClick={() => { const gp = Engine.get().input.gamepad(device.index); if (gp) change((q) => { const center = gp.axes[q.steer.axis]; if (center !== undefined && center > Math.min(q.steer.min, q.steer.max) + 0.1 && center < Math.max(q.steer.min, q.steer.max) - 0.1) q.steer.center = center }) }}>Set current position as centre</Button>
      </div>
    </>}
    <div className="controller-tune-grid">
      <Field label="Pedal deadzone" value={`${Math.round((p.pedalDeadzone ?? 0.02) * 100)}%`}><Slider value={p.pedalDeadzone ?? 0.02} min={0} max={0.2} onChange={(v) => change((q) => { q.pedalDeadzone = v })} /></Field>
      <Field label="Pedal travel / force for 100%" value={`${Math.round((p.pedalSaturation ?? 1) * 100)}%`}><Slider value={p.pedalSaturation ?? 1} min={0.4} max={1} onChange={(v) => change((q) => { q.pedalSaturation = v })} /></Field>
    </div>
    <p className="hint">Throttle: {mappingName(p.throttle)} · Brake: {mappingName(p.brake)}. Released pedals must read 0%; a full press must read 100%.</p>
    <div className="row">
      <Button size="small" disabled={!isAxisMap(p.throttle)} onClick={() => invertPedal('throttle')}>Invert throttle axis</Button>
      <Button size="small" disabled={!isAxisMap(p.brake)} onClick={() => invertPedal('brake')}>Invert brake axis</Button>
    </div>
    {p.kind !== 'pedals' && <div className="controller-bindings">
      {actionKeys.map((action) => <div key={action} className="controller-binding">
        <span>{BUTTON_LABELS[action]} <small>{p.buttons[action] >= 0 ? `· button ${p.buttons[action]}` : '· unbound'}</small></span>
        <Button size="small" onClick={() => bind(action)}>Bind</Button>
        <Button size="small" variant="ghost" onClick={() => change((q) => { q.buttons[action] = -1 })}>Clear</Button>
      </div>)}
    </div>}
  </div>
}

function BindingOverlay({ device, action, onSave, onCancel }: { device: ConnectedDevice; action: keyof DeviceButtons; onSave: (button: number) => void; onCancel: () => void }) {
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const [lost, setLost] = useState(false)
  useEffect(() => {
    const input = Engine.get().input
    input.muteActions = true
    let previous = input.gamepad(device.index)?.buttons.map((b) => b.pressed) ?? []
    let done = false
    const timer = window.setInterval(() => {
      const gp = input.gamepad(device.index)
      if (!gp || gp.id !== device.id) { setLost(true); return }
      setLost(false)
      const button = gp.buttons.findIndex((b, i) => b.pressed && !previous[i])
      previous = gp.buttons.map((b) => b.pressed)
      if (button >= 0 && !done) { done = true; saveRef.current(button) }
    }, 16)
    return () => { window.clearInterval(timer); input.muteActions = false }
  }, [device.index, device.id])
  return createPortal(<div className="overlay controller-overlay"><div className="panel overlay__box calib">
    <h2>Bind {BUTTON_LABELS[action]}</h2>
    <p>{lost ? 'Device disconnected. Reconnect it to continue.' : `Release the buttons, then press the button or paddle for ${BUTTON_LABELS[action].toLowerCase()}.`}</p>
    <p className="hint">The selected button will be removed from any other action on this device.</p>
    <Button onClick={onCancel}>Cancel</Button>
  </div></div>, document.body)
}

const STEP_LABEL: Record<CalibrationStep, string> = { steer: 'Steering', throttle: 'Throttle', brake: 'Brake', gearUp: 'Shift up', gearDown: 'Shift down', camera: 'Camera', pause: 'Pause', done: 'Done' }
function CalibrationOverlay({ device, onSave, onCancel }: { device: ConnectedDevice; onSave: (p: DeviceProfile) => void; onCancel: () => void }) {
  const calRef = useRef<Calibrator | null>(null)
  if (!calRef.current) calRef.current = new Calibrator(device.profile)
  const cal = calRef.current
  const [step, setStep] = useState<CalibrationStep>(cal.step)
  const [live, setLive] = useState({ value: 0, axis: -1, button: -1 })
  const [lost, setLost] = useState(false)
  const [nothing, setNothing] = useState(false)
  useEffect(() => {
    const input = Engine.get().input
    input.muteActions = true
    const first = input.gamepad(device.index)
    if (first) cal.begin(first)
    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const gp = input.gamepad(device.index)
      if (!gp || gp.id !== device.id) { setLost(true); return }
      setLost(false)
      const button = cal.sample(gp)
      setLive({ value: cal.live, axis: cal.liveAxis, button: cal.liveButton })
      const isButtonStep = cal.step !== 'steer' && cal.step !== 'throttle' && cal.step !== 'brake' && cal.step !== 'done'
      if (isButtonStep && button >= 0) { cal.commit(gp, button); setStep(cal.step); setNothing(false) }
    }
    raf = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(raf); input.muteActions = false }
  }, [cal, device.index, device.id])
  const next = () => {
    const gp = Engine.get().input.gamepad(device.index)
    if (!gp) return
    if (cal.commit(gp)) { setStep(cal.step); setNothing(false) } else setNothing(true)
  }
  const skip = () => {
    const gp = Engine.get().input.gamepad(device.index)
    if (!gp) return
    cal.skip(gp); setStep(cal.step); setNothing(false)
  }
  const axisStep = step === 'steer' || step === 'throttle' || step === 'brake'
  const index = CALIBRATION_STEPS.indexOf(step)
  const p = cal.profile
  const steps = p.kind === 'pedals' ? (['throttle', 'brake'] as const) : CALIBRATION_STEPS.filter((s) => s !== 'done')
  return createPortal(<div className="overlay controller-overlay" data-testid="calibration"><div className="panel overlay__box calib">
    <h2 className="pause__title" style={{ fontSize: 28 }}>Calibrate</h2>
    <div className="calib__device" title={device.id}>{shortName(device.id)}</div>
    <div className="calib__steps">{steps.map((s) => <span key={s} className={`calib__step ${CALIBRATION_STEPS.indexOf(s) < index ? 'calib__step--done' : ''} ${s === step ? 'calib__step--on' : ''}`}>{STEP_LABEL[s]}</span>)}</div>
    <p className="calib__prompt">{lost ? 'Controller disconnected. Plug it back in to continue.' : CALIBRATION_PROMPT[step]}</p>
    {axisStep && <div className="calib__meter" aria-label="live input"><div className="calib__meter-fill" style={{ width: `${Math.round(live.value * 100)}%` }} /><span className="calib__meter-text">{live.axis >= 0 ? `axis ${live.axis}` : live.button >= 0 ? `button ${live.button}` : 'move it…'}</span></div>}
    {nothing && <div className="hint calib__warn">Move the control through its full range. For steering, visit both end stops and return to centre before Next.</div>}
    {step === 'done' && <div className="calib__summary">
      {p.kind !== 'pedals' && <div>Steer: {mappingName(p.steer)}</div>}
      <div>Throttle: {mappingName(p.throttle)}</div><div>Brake: {mappingName(p.brake)}</div>
      {p.kind !== 'pedals' && <div>Shift up {p.buttons.gearUp} · Shift down {p.buttons.gearDown} · Camera {p.buttons.camera} · Pause {p.buttons.pause}</div>}
      {!p.calibrated && <p className="hint">Some driving controls were skipped. Their previous mappings are retained; check them in Tune / test.</p>}
    </div>}
    <div className="row calib__actions"><Button variant="ghost" onClick={onCancel}>Cancel</Button>
      {step !== 'done' && <Button variant="ghost" disabled={lost} onClick={skip}>Skip</Button>}
      {axisStep && <Button variant="primary" disabled={lost} onClick={next}>Next</Button>}
      {step === 'done' && <Button variant="primary" disabled={lost} onClick={() => onSave(p)}>Save</Button>}
    </div>
  </div></div>, document.body)
}
