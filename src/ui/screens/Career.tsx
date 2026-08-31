import { useState } from 'react'
import { Screen } from '../components/Screen'
import { Button } from '../components/Button'
import { Panel, Chip } from '../components/Controls'
import { useProfile } from '../hooks'
import { CAREER, careerEventToConfig, careerStars, chapterUnlocked, eventUnlocked, type CareerEvent } from '../../game/gameplay/Career'
import { GAME_MODES, defaultRaceConfig } from '../../game/gameplay/GameModes'
import { TRACK_BY_ID } from '../../game/tracks/TrackCatalog'
import { getVehicleSpec, VEHICLE_CLASS_LABEL } from '../../game/vehicles/VehicleCatalog'
import { allDrivers } from '../../game/ai/DriverProfiles'
import { Engine } from '../../game/core/Engine'
import { formatCredits } from '../../game/core/MathUtils'
import { navigate, pushToast } from '../../game/state/GameStore'

export function CareerScreen() {
  const profile = useProfile()
  const [selected, setSelected] = useState<CareerEvent | null>(null)
  const stars = careerStars()
  const car = getVehicleSpec(profile.selectedCar)
  const rival = selected?.rivalId ? allDrivers().find((d) => d.id === selected.rivalId) : null
  const classOk = !selected?.requiredClass || selected.requiredClass.includes(car.vehicleClass)

  const start = () => {
    if (!selected) return
    if (!classOk) {
      pushToast(`This event requires: ${selected.requiredClass!.map((c) => VEHICLE_CLASS_LABEL[c as keyof typeof VEHICLE_CLASS_LABEL]).join(' / ')}`, '⚠️')
      return
    }
    const cfg = defaultRaceConfig({ ...careerEventToConfig(selected, profile.selectedCar), difficulty: profile.settings.gameplay.difficulty, timeRate: 0.25 })
    if (cfg.mode === 'championship' || cfg.mode === 'knockout') void Engine.get().startSeries(cfg, cfg.mode)
    else void Engine.get().startRace(cfg)
  }

  return (
    <Screen title="Story" subtitle={`${stars} stars earned · ${profile.career.completedEvents.length} events complete`}>
      <div className="col scroll" style={{ flex: 1 }}>
        {CAREER.map((ch) => {
          const unlocked = chapterUnlocked(ch)
          return (
            <div key={ch.index} className="chapter">
              <h3 className="chapter__title">
                {ch.title} {!unlocked && <Chip tone="gold">{ch.starsToUnlock} ★ required</Chip>}
              </h3>
              <p className="chapter__blurb">{ch.blurb}</p>
              <div className="events">
                {ch.events.map((ev, i) => {
                  const s = profile.career.eventStars[ev.id] ?? 0
                  const open = eventUnlocked(ch, i)
                  const t = TRACK_BY_ID[ev.trackId]
                  return (
                    <div key={ev.id} className={`card ${selected?.id === ev.id ? 'card--on' : ''} ${!open ? 'card--locked' : ''}`} onClick={() => open && setSelected(ev)}>
                      <div className="card__title">
                        {GAME_MODES[ev.mode].icon} {ev.title}
                      </div>
                      <div className="card__sub">
                        {t?.name} · {GAME_MODES[ev.mode].title}
                      </div>
                      <div className="event__stars">{'★'.repeat(s)}{'☆'.repeat(3 - s)}</div>
                      {!open && <div className="card__badge">Locked</div>}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <div className="col" style={{ width: 360, flexShrink: 0 }}>
        {selected ? (
          <Panel title={selected.title}>
            <p style={{ fontSize: 13, lineHeight: 1.5, marginTop: 0 }}>{selected.intro}</p>
            <div className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
              <Chip>{TRACK_BY_ID[selected.trackId]?.name}</Chip>
              <Chip>{GAME_MODES[selected.mode].title}</Chip>
              {selected.laps > 1 && <Chip>{selected.laps} laps</Chip>}
              {selected.aiCount > 0 && <Chip>{selected.aiCount} rivals · {selected.aiMix}</Chip>}
              <Chip>{selected.weather === 'random' ? 'Dynamic weather' : selected.weather}</Chip>
            </div>
            {rival && (
              <div style={{ fontSize: 12, marginBottom: 8 }}>
                <b style={{ color: rival.color }}>Rival:</b> {rival.name} ({rival.tier})
              </div>
            )}
            {selected.requiredClass && (
              <div style={{ fontSize: 12, color: classOk ? 'var(--green)' : 'var(--gold)', marginBottom: 8 }}>
                Requires {selected.requiredClass.map((c) => VEHICLE_CLASS_LABEL[c as keyof typeof VEHICLE_CLASS_LABEL]).join(' / ')} — you have {VEHICLE_CLASS_LABEL[car.vehicleClass]}
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Reward {formatCredits(selected.rewardCredits)}
              {selected.rewardCar && ` + ${getVehicleSpec(selected.rewardCar).brand} ${getVehicleSpec(selected.rewardCar).name}`}
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <Button variant="primary" onClick={start}>
                Enter event ▶
              </Button>
              <Button variant="ghost" onClick={() => navigate('garage')}>
                Garage
              </Button>
            </div>
          </Panel>
        ) : (
          <Panel title="Select an event">
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>Earn stars to unlock chapters: 3 for a win, 2 for a podium, 1 for a top-six finish. Drift and time-trial events score on points and lap time.</p>
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>
              You are driving the <b style={{ color: '#fff' }}>{car.brand} {car.name}</b>.
            </p>
          </Panel>
        )}
      </div>
    </Screen>
  )
}
