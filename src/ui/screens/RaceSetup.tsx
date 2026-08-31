/**
 * Race staging: mode, circuit, laps, field, difficulty, weather, time.
 */

import { useMemo, useState } from 'react'
import { Screen } from '../components/Screen'
import { Button } from '../components/Button'
import { Panel, Segmented, Field, Slider, Toggle, Chip } from '../components/Controls'
import { useProfile } from '../hooks'
import { GAME_MODES, defaultRaceConfig, DIFFICULTY_LABEL, type GameModeId, type RaceConfig } from '../../game/gameplay/GameModes'
import { TRACK_CATALOG, WEATHER_LABEL, type WeatherKind } from '../../game/tracks/TrackCatalog'
import { getVehicleSpec } from '../../game/vehicles/VehicleCatalog'
import { Engine } from '../../game/core/Engine'
import { navigate } from '../../game/state/GameStore'
import type { DifficultyLevel } from '../../game/core/Settings'
import type { FieldMix } from '../../game/ai/DriverProfiles'
import { leaderboards } from '../../game/gameplay/Leaderboards'
import { formatTime } from '../../game/core/MathUtils'

const MODE_ORDER: GameModeId[] = ['quick', 'timetrial', 'championship', 'elimination', 'drift', 'sprint', 'endurance', 'knockout', 'freeroam']

export function RaceSetupScreen() {
  const profile = useProfile()
  const [config, setConfig] = useState<RaceConfig>(() => defaultRaceConfig({ carId: profile.selectedCar, difficulty: profile.settings.gameplay.difficulty, trackId: profile.unlockedTracks[0] ?? 'island-causeway' }))
  const mode = GAME_MODES[config.mode]
  const track = useMemo(() => TRACK_CATALOG.find((t) => t.id === config.trackId) ?? TRACK_CATALOG[0], [config.trackId])
  const car = getVehicleSpec(profile.selectedCar)
  const patch = (p: Partial<RaceConfig>) => setConfig((c) => ({ ...c, ...p }))
  const setMode = (m: GameModeId) => {
    const def = GAME_MODES[m]
    const t = TRACK_CATALOG.find((x) => x.id === config.trackId)!
    let trackId = config.trackId
    if (def.pointToPoint && t.closed) trackId = TRACK_CATALOG.find((x) => !x.closed && profile.unlockedTracks.includes(x.id))?.id ?? trackId
    if (!def.pointToPoint && !t.closed && m !== 'freeroam') trackId = TRACK_CATALOG.find((x) => x.closed && profile.unlockedTracks.includes(x.id))?.id ?? trackId
    patch({ mode: m, trackId, laps: def.defaultLaps === 'track' ? (TRACK_CATALOG.find((x) => x.id === trackId)?.defaultLaps ?? 3) : def.defaultLaps, aiCount: Math.min(def.aiDefault, def.aiMax) })
  }
  const best = leaderboards.playerBest(config.trackId)
  const start = () => {
    const cfg: RaceConfig = { ...config, carId: profile.selectedCar, seed: Math.floor(Math.random() * 1e9), dynamicWeather: config.weather === 'random' || config.dynamicWeather }
    if (cfg.mode === 'championship' || cfg.mode === 'knockout') void Engine.get().startSeries(cfg, cfg.mode)
    else void Engine.get().startRace(cfg)
  }

  return (
    <Screen
      title="Race Staging"
      subtitle={`${car.brand} ${car.name}`}
      actions={
        <Button variant="primary" size="big" onClick={start}>
          Start ▶
        </Button>
      }
    >
      <div className="col scroll" style={{ flex: 1 }}>
        <Panel title="Event">
          <div className="grid-3">
            {MODE_ORDER.map((id) => {
              const m = GAME_MODES[id]
              return (
                <div key={id} className={`card ${config.mode === id ? 'card--on' : ''}`} onClick={() => setMode(id)}>
                  <div className="card__title">
                    {m.icon} {m.title}
                  </div>
                  <div className="card__sub">{m.subtitle}</div>
                </div>
              )
            })}
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 0' }}>{mode.description}</p>
        </Panel>
        <Panel title="Circuit">
          <div className="grid-3">
            {TRACK_CATALOG.map((t) => {
              const unlocked = profile.unlockedTracks.includes(t.id)
              const incompatible = (mode.pointToPoint && t.closed) || (!mode.pointToPoint && !t.closed && config.mode !== 'freeroam')
              return (
                <div key={t.id} className={`card ${config.trackId === t.id ? 'card--on' : ''} ${!unlocked || incompatible ? 'card--locked' : ''}`} onClick={() => unlocked && !incompatible && patch({ trackId: t.id, laps: mode.defaultLaps === 'track' ? t.defaultLaps : config.laps })}>
                  <div className="card__title">{t.name}</div>
                  <div className="card__sub">
                    {t.location} · {t.lengthKm} km · {'★'.repeat(t.difficulty)}
                  </div>
                  <div className="card__badge">{!unlocked ? `Lv ${t.unlockLevel}` : incompatible ? (t.closed ? 'Circuit' : 'Sprint') : t.closed ? 'Circuit' : 'Point-to-point'}</div>
                </div>
              )
            })}
          </div>
          <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <Chip>{track.location}</Chip>
            <Chip>{track.features.filter((f) => f.type === 'shortcut').length} shortcuts</Chip>
            <Chip>{track.features.filter((f) => f.type === 'hazard').length} hazards</Chip>
            {best && <Chip tone="gold">Your best {formatTime(best)}</Chip>}
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0' }}>{track.description}</p>
        </Panel>
      </div>
      <div className="col" style={{ width: 340, flexShrink: 0 }}>
        <Panel title="Session">
          {mode.lapsSelectable && (
            <Field label="Laps" value={config.laps}>
              <Slider value={config.laps} min={1} max={config.mode === 'endurance' ? 30 : 10} step={1} onChange={(laps) => patch({ laps })} />
            </Field>
          )}
          {mode.aiMax > 0 && (
            <>
              <Field label="Rivals" value={config.aiCount}>
                <Slider value={config.aiCount} min={config.mode === 'drift' ? 0 : 1} max={mode.aiMax} step={1} onChange={(aiCount) => patch({ aiCount })} />
              </Field>
              <Field label="Field competency">
                <Segmented<FieldMix> value={config.aiMix} options={(['mixed', 'rookie', 'amateur', 'pro', 'elite', 'legend'] as FieldMix[]).map((v) => ({ value: v, label: v }))} onChange={(aiMix) => patch({ aiMix })} />
              </Field>
              <Field label="Difficulty">
                <Segmented<DifficultyLevel> value={config.difficulty} options={(Object.keys(DIFFICULTY_LABEL) as DifficultyLevel[]).map((v) => ({ value: v, label: DIFFICULTY_LABEL[v] }))} onChange={(difficulty) => patch({ difficulty })} />
              </Field>
            </>
          )}
          <Field label="Weather">
            <Segmented<WeatherKind | 'random'> value={config.weather} options={[{ value: 'random' as const, label: 'Dynamic' }, ...track.environment.weatherOptions.map((w) => ({ value: w, label: WEATHER_LABEL[w] }))]} onChange={(weather) => patch({ weather })} />
          </Field>
          <Field label="Time of day" value={config.hour === 'default' ? `Track default (${track.environment.defaultHour}:00)` : `${String(config.hour).padStart(2, '0')}:00`}>
            <Slider value={config.hour === 'default' ? track.environment.defaultHour : config.hour} min={0} max={23} step={1} onChange={(hour) => patch({ hour })} />
            <div className="row" style={{ marginTop: 4 }}>
              <Button size="small" variant="ghost" onClick={() => patch({ hour: 'default' })}>
                Reset
              </Button>
              <Field label="Clock speed" value={config.timeRate === 0 ? 'Frozen' : `${config.timeRate} h / min`}>
                <Slider value={config.timeRate} min={0} max={6} step={0.25} onChange={(timeRate) => patch({ timeRate })} />
              </Field>
            </div>
          </Field>
          <div className="col">
            <Toggle value={config.dynamicWeather} onChange={(dynamicWeather) => patch({ dynamicWeather })} label="Changing weather during the race" />
            {config.mode === 'timetrial' && <Toggle value={config.ghost} onChange={(ghost) => patch({ ghost })} label="Race your best-lap ghost" />}
          </div>
        </Panel>
        <Button variant="ghost" onClick={() => navigate('garage')}>
          Change car
        </Button>
      </div>
    </Screen>
  )
}
