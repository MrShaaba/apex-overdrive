/**
 * "Wheels & controllers" options panel: lists connected gamepads and racing
 * wheels, assigns each to a player, and runs the calibration sequence (steering
 * lock to lock, each pedal, then the buttons for shift / camera / pause). The
 * result is stored per device id in settings.controls.devices.
 */

import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { Panel, Segmented, Field, Chip } from './Controls'
import { Engine } from '../../game/core/Engine'
import { KEYBOARD_DEVICE, type ConnectedDevice } from '../../game/input/InputManager'
import { Calibrator, CALIBRATION_PROMPT, CALIBRATION_STEPS, type CalibrationStep, type DeviceProfile } from '../../game/input/Gamepads'
import type { Settings } from '../../game/core/Settings'

type Assignment = string | null

const shortName = (id: string) => id.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || id.slice(0, 40)

export function DevicePanel({ settings, update }: { settings: Settings; update: (fn: (s: Settings) => void) => void }) {
  const [devices, setDevices] = useState<ConnectedDevice[]>([])
  const [calibrating, setCalibrating] = useState<ConnectedDevice | null>(null)

  // Poll: the Gamepad API has no event for pads that were plugged in before the page loaded
  // until a button is pressed, and assignments can change from outside this screen.
  useEffect(() => {
    const tick = () => setDevices(Engine.get().input.listDevices())
    tick()
    const h = window.setInterval(tick, 500)
    return () => window.clearInterval(h)
  }, [])

  const players = settings.controls.players
  const setPlayer = (player: 0 | 1, id: Assignment) =>
    update((s) => {
      s.controls.players[player] = id
      // A device can only feed one player.
      if (id && s.controls.players[1 - player] === id) s.controls.players[1 - player] = null
    })
  const playerOptions = (player: 0 | 1) => [
    { value: '__auto', label: player === 0 ? 'Keyboard + first pad' : 'Second pad' },
    ...(player === 1 ? [{ value: KEYBOARD_DEVICE, label: 'Keyboard' }] : []),
    ...devices.map((d) => ({ value: d.id, label: shortName(d.id) })),
  ]
  const valueFor = (player: 0 | 1) => {
    const v = players[player]
    if (!v) return '__auto'
    if (v === KEYBOARD_DEVICE) return v
    // Keep a saved but unplugged device visible so the assignment is not silently lost.
    return devices.some((d) => d.id === v) ? v : '__auto'
  }

  const onSaveProfile = (profile: DeviceProfile) => {
    update((s) => {
      s.controls.devices[profile.id] = profile
    })
    setCalibrating(null)
  }

  return (
    <Panel title="Wheels & controllers">
      <p className="hint" style={{ marginTop: 0 }}>
        Plug in a gamepad or racing wheel (Logitech G29 / G920 / G923, Thrustmaster, Fanatec…) and press any button so the browser lists it. Wheels put steering and each pedal on their own axis, so run Calibrate once per device; it is saved for that device. Force feedback is not available in browsers.
      </p>
      {devices.length === 0 && <div className="hint">No controllers detected. Press a button on the device to wake it.</div>}
      {devices.map((d) => (
        <div key={d.index} className="device-row" data-testid="device-row">
          <div className="device-row__info">
            <div className="device-row__name" title={d.id}>
              {d.profile.kind === 'wheel' ? '🏎️' : '🎮'} {shortName(d.id)}
            </div>
            <div className="device-row__meta">
              <Chip tone={d.profile.calibrated ? 'accent' : undefined}>{d.profile.calibrated ? 'Calibrated' : d.profile.kind === 'wheel' ? 'Wheel · default map' : 'Pad · standard map'}</Chip>
              {d.player >= 0 && <Chip tone="gold">Player {d.player + 1}</Chip>}
            </div>
          </div>
          <div className="device-row__actions">
            <Button size="small" onClick={() => setPlayer(0, d.id)} disabled={players[0] === d.id}>
              P1
            </Button>
            <Button size="small" onClick={() => setPlayer(1, d.id)} disabled={players[1] === d.id}>
              P2
            </Button>
            <Button size="small" variant="primary" onClick={() => setCalibrating(d)}>
              Calibrate
            </Button>
          </div>
        </div>
      ))}
      <Field label="Player 1 device">
        <Segmented<string> value={valueFor(0)} options={playerOptions(0)} onChange={(v) => setPlayer(0, v === '__auto' ? null : v)} />
      </Field>
      <Field label="Player 2 device">
        <Segmented<string> value={valueFor(1)} options={playerOptions(1)} onChange={(v) => setPlayer(1, v === '__auto' ? null : v)} />
      </Field>
      {calibrating && <CalibrationOverlay device={calibrating} onSave={onSaveProfile} onCancel={() => setCalibrating(null)} />}
    </Panel>
  )
}

const STEP_LABEL: Record<CalibrationStep, string> = {
  steer: 'Steering',
  throttle: 'Throttle',
  brake: 'Brake',
  gearUp: 'Shift up',
  gearDown: 'Shift down',
  camera: 'Camera',
  pause: 'Pause',
  done: 'Done',
}

function CalibrationOverlay({ device, onSave, onCancel }: { device: ConnectedDevice; onSave: (p: DeviceProfile) => void; onCancel: () => void }) {
  const calRef = useRef<Calibrator | null>(null)
  if (!calRef.current) calRef.current = new Calibrator(device.profile)
  const cal = calRef.current
  const [step, setStep] = useState<CalibrationStep>(cal.step)
  const [live, setLive] = useState({ value: 0, axis: -1 })
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
      if (!gp) {
        setLost(true)
        return
      }
      setLost(false)
      const button = cal.sample(gp)
      setLive({ value: cal.live, axis: cal.liveAxis })
      const isButtonStep = cal.step !== 'steer' && cal.step !== 'throttle' && cal.step !== 'brake' && cal.step !== 'done'
      if (isButtonStep && button >= 0) {
        cal.commit(gp, button)
        setStep(cal.step)
        setNothing(false)
      }
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      input.muteActions = false
    }
  }, [cal, device.index])

  const next = () => {
    const gp = Engine.get().input.gamepad(device.index)
    if (!gp) return
    if (cal.commit(gp)) {
      setStep(cal.step)
      setNothing(false)
    } else setNothing(true)
  }
  const skip = () => {
    const gp = Engine.get().input.gamepad(device.index)
    if (!gp) return
    cal.skip(gp)
    setStep(cal.step)
    setNothing(false)
  }

  const axisStep = step === 'steer' || step === 'throttle' || step === 'brake'
  const index = CALIBRATION_STEPS.indexOf(step)
  const p = cal.profile

  return (
    <div className="overlay" data-testid="calibration">
      <div className="panel overlay__box calib">
        <h2 className="pause__title" style={{ fontSize: 28 }}>
          Calibrate
        </h2>
        <div className="calib__device" title={device.id}>
          {shortName(device.id)}
        </div>
        <div className="calib__steps">
          {CALIBRATION_STEPS.filter((s) => s !== 'done').map((s, i) => (
            <span key={s} className={`calib__step ${i < index ? 'calib__step--done' : ''} ${s === step ? 'calib__step--on' : ''}`}>
              {STEP_LABEL[s]}
            </span>
          ))}
        </div>
        <p className="calib__prompt">{lost ? 'Controller disconnected. Plug it back in to continue.' : CALIBRATION_PROMPT[step]}</p>
        {axisStep && (
          <div className="calib__meter" aria-label="live input">
            <div className="calib__meter-fill" style={{ width: `${Math.round(live.value * 100)}%` }} />
            <span className="calib__meter-text">{live.axis >= 0 ? `axis ${live.axis}` : 'move it…'}</span>
          </div>
        )}
        {nothing && <div className="hint calib__warn">Nothing moved far enough. Move that control through its full range, then press Next.</div>}
        {step === 'done' && (
          <div className="calib__summary">
            <div>Steer: axis {p.steer.axis}</div>
            <div>Throttle: {'axis' in p.throttle ? `axis ${p.throttle.axis}` : `button ${p.throttle.button}`}</div>
            <div>Brake: {'axis' in p.brake ? `axis ${p.brake.axis}` : `button ${p.brake.button}`}</div>
            <div>
              Shift up {p.buttons.gearUp} · Shift down {p.buttons.gearDown} · Camera {p.buttons.camera} · Pause {p.buttons.pause}
            </div>
          </div>
        )}
        <div className="row calib__actions">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          {step !== 'done' && (
            <Button variant="ghost" onClick={skip}>
              Skip
            </Button>
          )}
          {axisStep && (
            <Button variant="primary" onClick={next}>
              Next
            </Button>
          )}
          {step === 'done' && (
            <Button variant="primary" onClick={() => onSave(p)}>
              Save
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
