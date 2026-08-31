import { useState } from 'react'
import { Screen } from '../components/Screen'
import { Button } from '../components/Button'
import { Panel, Segmented, Field, Slider, Toggle } from '../components/Controls'
import { useProfile } from '../hooks'
import { Engine } from '../../game/core/Engine'
import { saveManager } from '../../game/persistence/SaveManager'
import { bumpProfile, pushToast, useGameStore } from '../../game/state/GameStore'
import type { Settings, QualityPreset, ShadowQuality, AntiAliasMode, TouchLayout, TransmissionMode, SpeedUnits, DifficultyLevel, DamageMode, CameraMode } from '../../game/core/Settings'
import { Logger } from '../../game/core/Logger'

type Tab = 'graphics' | 'audio' | 'controls' | 'gameplay' | 'profile'

export function OptionsScreen() {
  const profile = useProfile()
  const [tab, setTab] = useState<Tab>('graphics')
  const quality = useGameStore((s) => s.quality)
  const settings = profile.settings
  const [usage, setUsage] = useState<string>('')
  const update = (fn: (s: Settings) => void) => {
    const next: Settings = JSON.parse(JSON.stringify(settings))
    fn(next)
    Engine.get().applySettings(next)
    bumpProfile()
  }
  const g = settings.graphics
  const a = settings.audio
  const c = settings.controls
  const gp = settings.gameplay
  const exportSave = () => {
    const blob = new Blob([saveManager.exportJson()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'apex-overdrive-save.json'
    link.click()
    URL.revokeObjectURL(url)
  }
  const importSave = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      const ok = await saveManager.importJson(await f.text())
      pushToast(ok ? 'Save imported' : 'Invalid save file', ok ? '✅' : '⚠️')
      bumpProfile()
    }
    input.click()
  }
  return (
    <Screen title="Options" subtitle={`Quality ${quality.preset} · render scale ${Math.round(quality.scale * 100)}% · ${Math.round(Engine.get().fps)} fps`}>
      <div className="col" style={{ flex: 1 }}>
        <div className="tabs">
          {(['graphics', 'audio', 'controls', 'gameplay', 'profile'] as Tab[]).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'tab--on' : ''}`} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="scroll grid-2" style={{ alignContent: 'start' }}>
          {tab === 'graphics' && (
            <>
              <Panel title="Quality">
                <Field label="Preset">
                  <Segmented<QualityPreset> value={g.preset} options={(['auto', 'low', 'medium', 'high', 'ultra'] as QualityPreset[]).map((v) => ({ value: v, label: v }))} onChange={(preset) => update((s) => (s.graphics.preset = preset))} />
                </Field>
                <Field label="Render scale" value={`${Math.round(g.resolutionScale * 100)}%`}>
                  <Slider value={g.resolutionScale} min={0.5} max={1} step={0.05} onChange={(v) => update((s) => (s.graphics.resolutionScale = v))} />
                </Field>
                <Toggle value={g.dynamicScaling} onChange={(v) => update((s) => (s.graphics.dynamicScaling = v))} label="Dynamic resolution (hold 60 fps)" />
                <Field label="Draw distance" value={`${Math.round(g.drawDistance * 100)}%`}>
                  <Slider value={g.drawDistance} min={0.3} max={1.5} step={0.1} onChange={(v) => update((s) => (s.graphics.drawDistance = v))} />
                </Field>
                <Field label="Field of view" value={`${g.fovBase}°`}>
                  <Slider value={g.fovBase} min={50} max={90} step={1} onChange={(v) => update((s) => (s.graphics.fovBase = v))} />
                </Field>
              </Panel>
              <Panel title="Effects">
                <Field label="Shadows">
                  <Segmented<ShadowQuality> value={g.shadows} options={(['off', 'low', 'medium', 'high'] as ShadowQuality[]).map((v) => ({ value: v, label: v }))} onChange={(v) => update((s) => (s.graphics.shadows = v))} />
                </Field>
                <Field label="Anti-aliasing">
                  <Segmented<AntiAliasMode> value={g.antialias} options={(['none', 'fxaa', 'smaa'] as AntiAliasMode[]).map((v) => ({ value: v, label: v }))} onChange={(v) => update((s) => (s.graphics.antialias = v))} />
                </Field>
                <div className="col">
                  <Toggle value={g.ssao} onChange={(v) => update((s) => (s.graphics.ssao = v))} label="Screen-space ambient occlusion" />
                  <Toggle value={g.bloom} onChange={(v) => update((s) => (s.graphics.bloom = v))} label="Bloom glow" />
                  <Toggle value={g.motionBlur} onChange={(v) => update((s) => (s.graphics.motionBlur = v))} label="Speed blur" />
                  <Toggle value={g.reflections} onChange={(v) => update((s) => (s.graphics.reflections = v))} label="High-quality reflections" />
                  <Toggle value={g.showFps} onChange={(v) => update((s) => (s.graphics.showFps = v))} label="Show FPS counter" />
                </div>
                <Field label="Particle density" value={`${Math.round(g.particleDensity * 100)}%`}>
                  <Slider value={g.particleDensity} min={0.1} max={1.5} step={0.1} onChange={(v) => update((s) => (s.graphics.particleDensity = v))} />
                </Field>
              </Panel>
            </>
          )}
          {tab === 'audio' && (
            <Panel title="Mix">
              {(['master', 'engine', 'sfx', 'music', 'ambience'] as const).map((k) => (
                <Field key={k} label={k} value={`${Math.round(a[k] * 100)}%`}>
                  <Slider value={a[k]} min={0} max={1} onChange={(v) => update((s) => (s.audio[k] = v))} />
                </Field>
              ))}
              <Toggle value={a.muteInBackground} onChange={(v) => update((s) => (s.audio.muteInBackground = v))} label="Mute when the tab is hidden" />
            </Panel>
          )}
          {tab === 'controls' && (
            <>
              <Panel title="Steering">
                <Field label="Sensitivity" value={c.steeringSensitivity.toFixed(2)}>
                  <Slider value={c.steeringSensitivity} min={0.4} max={1.6} onChange={(v) => update((s) => (s.controls.steeringSensitivity = v))} />
                </Field>
                <Field label="Controller deadzone" value={c.steeringDeadzone.toFixed(2)}>
                  <Slider value={c.steeringDeadzone} min={0} max={0.3} onChange={(v) => update((s) => (s.controls.steeringDeadzone = v))} />
                </Field>
                <Field label="Touch layout">
                  <Segmented<TouchLayout> value={c.touchLayout} options={[{ value: 'buttons', label: 'Buttons' }, { value: 'tilt', label: 'Tilt to steer' }, { value: 'wheel', label: 'Wheel' }]} onChange={(v) => update((s) => (s.controls.touchLayout = v))} />
                </Field>
                <Field label="Tilt sensitivity" value={c.tiltSensitivity.toFixed(2)}>
                  <Slider value={c.tiltSensitivity} min={0.5} max={2} onChange={(v) => update((s) => (s.controls.tiltSensitivity = v))} />
                </Field>
                <Toggle value={c.vibration} onChange={(v) => update((s) => (s.controls.vibration = v))} label="Vibration on impact (mobile)" />
              </Panel>
              <Panel title="Assists & units">
                <Field label="Transmission">
                  <Segmented<TransmissionMode> value={c.transmission} options={[{ value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'Manual (Q/E)' }]} onChange={(v) => update((s) => (s.controls.transmission = v))} />
                </Field>
                <Field label="Speed units">
                  <Segmented<SpeedUnits> value={c.units} options={[{ value: 'kmh', label: 'km/h' }, { value: 'mph', label: 'mph' }]} onChange={(v) => update((s) => (s.controls.units = v))} />
                </Field>
                <div className="col">
                  <Toggle value={c.abs} onChange={(v) => update((s) => (s.controls.abs = v))} label="ABS" />
                  <Toggle value={c.tractionControl} onChange={(v) => update((s) => (s.controls.tractionControl = v))} label="Traction control" />
                  <Toggle value={c.stabilityControl} onChange={(v) => update((s) => (s.controls.stabilityControl = v))} label="Stability control" />
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10, lineHeight: 1.6 }}>
                  <b>Keyboard:</b> WASD / arrows drive · Space handbrake · Shift nitro · Q/E gears · C camera · B look back · R reset · F photo · V replay · N hide HUD · Esc pause.
                  <br />
                  <b>Gamepad:</b> left stick steer · RT throttle · LT brake · B handbrake · push stick up for nitro · Y camera · bumpers shift · Start pause.
                </div>
              </Panel>
            </>
          )}
          {tab === 'gameplay' && (
            <>
              <Panel title="Simulation">
                <Field label="Default AI difficulty">
                  <Segmented<DifficultyLevel> value={gp.difficulty} options={(['adaptive', 'rookie', 'amateur', 'pro', 'legend'] as DifficultyLevel[]).map((v) => ({ value: v, label: v }))} onChange={(v) => update((s) => (s.gameplay.difficulty = v))} />
                </Field>
                <Field label="Damage">
                  <Segmented<DamageMode> value={gp.damage} options={[{ value: 'full', label: 'Full' }, { value: 'visual', label: 'Visual only' }, { value: 'off', label: 'Off' }]} onChange={(v) => update((s) => (s.gameplay.damage = v))} />
                </Field>
                <Toggle value={gp.fuelConsumption} onChange={(v) => update((s) => (s.gameplay.fuelConsumption = v))} label="Fuel consumption in endurance events" />
                <Toggle value={gp.showGhost} onChange={(v) => update((s) => (s.gameplay.showGhost = v))} label="Show ghost in time trials" />
                <Toggle value={gp.showMinimap} onChange={(v) => update((s) => (s.gameplay.showMinimap = v))} label="Show route map" />
              </Panel>
              <Panel title="Camera & HUD">
                <Field label="Default camera">
                  <Segmented<CameraMode> value={gp.defaultCamera} options={(['chase', 'chaseFar', 'hood', 'cockpit'] as CameraMode[]).map((v) => ({ value: v, label: v }))} onChange={(v) => update((s) => (s.gameplay.defaultCamera = v))} />
                </Field>
                <Field label="HUD scale" value={`${Math.round(gp.hudScale * 100)}%`}>
                  <Slider value={gp.hudScale} min={0.7} max={1.3} step={0.05} onChange={(v) => update((s) => (s.gameplay.hudScale = v))} />
                </Field>
              </Panel>
            </>
          )}
          {tab === 'profile' && (
            <>
              <Panel title="Driver">
                <Field label="Name">
                  <input
                    type="text"
                    maxLength={16}
                    value={profile.playerName}
                    onChange={(e) => {
                      saveManager.update((p) => {
                        p.playerName = e.target.value || 'Driver'
                        p.settings.gameplay.playerName = p.playerName
                      })
                      bumpProfile()
                    }}
                  />
                </Field>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <Button onClick={exportSave}>Export save</Button>
                  <Button onClick={importSave}>Import save</Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      if (confirm('Reset all progress? This cannot be undone.')) void saveManager.reset().then(() => window.location.reload())
                    }}
                  >
                    Reset progress
                  </Button>
                </div>
              </Panel>
              <Panel title="Diagnostics">
                <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>
                  Storage backend: localStorage (cloud adapter available) · {usage || 'usage unknown'}
                  <br />
                  Renderer: {(() => { try { return Engine.get().renderer.capabilities.isWebGL2 ? 'WebGL 2' : 'WebGL 1' } catch { return 'n/a' } })()}
                  <br />
                  Save version {profile.version} · created {new Date(profile.createdAt).toLocaleDateString()}
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <Button size="small" onClick={() => void saveManager.storageUsage().then((u) => setUsage(`${(u.bytes / 1024).toFixed(1)} KB used`))}>
                    Measure storage
                  </Button>
                  <Button size="small" variant="ghost" onClick={() => console.table(Logger.getHistory())}>
                    Dump log to console
                  </Button>
                </div>
              </Panel>
            </>
          )}
        </div>
      </div>
    </Screen>
  )
}
