/**
 * Workshop: buy / select cars, cosmetic customization and mechanical
 * upgrades. Every change is previewed live on the showcase turntable.
 */

import { useEffect, useMemo, useState } from 'react'
import { Screen } from '../components/Screen'
import { Button } from '../components/Button'
import { Panel, Segmented, Field, Slider, StatBar, Chip } from '../components/Controls'
import { useProfile } from '../hooks'
import { VEHICLE_CATALOG, VEHICLE_CLASS_LABEL, getVehicleSpec } from '../../game/vehicles/VehicleCatalog'
import { applyUpgrades, computeRatings, PAINT_SWATCHES, FINISHES, RIM_STYLES, TIRE_STYLES, WING_STYLES, BUMPER_STYLES, LIVERY_STYLES, UPGRADE_CATEGORIES, UPGRADE_INFO, MAX_UPGRADE_LEVEL, upgradeCost, type VehicleCustomization, type UpgradeCategory } from '../../game/vehicles/VehicleSpec'
import { saveManager } from '../../game/persistence/SaveManager'
import { ensureCarState, purchaseCar, repairCar } from '../../game/gameplay/Progression'
import { Engine } from '../../game/core/Engine'
import { formatCredits } from '../../game/core/MathUtils'
import { bumpProfile, pushToast, navigate } from '../../game/state/GameStore'
import { evaluateAchievements } from '../../game/gameplay/Achievements'

type Tab = 'overview' | 'style' | 'upgrades'

export function GarageScreen() {
  const profile = useProfile()
  const [selected, setSelected] = useState(profile.selectedCar)
  const [tab, setTab] = useState<Tab>('overview')
  const spec = getVehicleSpec(selected)
  const owned = profile.ownedCars.includes(selected)
  useEffect(() => {
    ensureCarState(selected)
    Engine.get().setShowcaseCar(selected)
  }, [selected])
  const state = profile.cars[selected]
  const custom = state?.customization
  const upgrades = state?.upgrades
  const tuned = useMemo(() => (upgrades ? applyUpgrades(spec, upgrades, custom) : spec), [spec, upgrades, custom])
  const ratings = useMemo(() => computeRatings(tuned), [tuned])
  const baseRatings = useMemo(() => computeRatings(spec), [spec])

  const updateCustom = (patch: Partial<VehicleCustomization>) => {
    saveManager.update((p) => {
      Object.assign(p.cars[selected].customization, patch)
    })
    Engine.get().setShowcaseCar(selected, saveManager.get().cars[selected].customization)
    bumpProfile()
  }

  const buyUpgrade = (cat: UpgradeCategory) => {
    if (!upgrades) return
    const level = upgrades[cat]
    if (level >= MAX_UPGRADE_LEVEL) return
    const cost = upgradeCost(cat, level, spec.tier)
    if (profile.credits < cost) {
      pushToast('Not enough credits', '💸')
      Engine.get().audio?.playUI('error')
      return
    }
    saveManager.update((p) => {
      p.credits -= cost
      p.cars[selected].upgrades[cat] = level + 1
    })
    Engine.get().audio?.playUI('purchase')
    bumpProfile()
  }

  const select = () => {
    saveManager.update((p) => {
      p.selectedCar = selected
    })
    bumpProfile()
    pushToast(`${spec.brand} ${spec.name} selected`, '🚗')
  }

  const buy = () => {
    const r = purchaseCar(selected)
    if (!r.ok) {
      pushToast(r.reason ?? 'Cannot purchase', '⚠️')
      Engine.get().audio?.playUI('error')
      return
    }
    Engine.get().audio?.playUI('purchase')
    evaluateAchievements(null)
    bumpProfile()
  }

  const repair = () => {
    const r = repairCar(selected)
    if (!r.ok) pushToast(`Repair costs ${formatCredits(r.cost)}`, '💸')
    else pushToast(r.cost ? `Repaired for ${formatCredits(r.cost)}` : 'No damage to repair', '🔧')
    bumpProfile()
  }

  return (
    <Screen
      title="Workshop"
      subtitle={`${formatCredits(profile.credits)} · Level ${profile.level}`}
      actions={
        <div className="row">
          {owned && profile.selectedCar !== selected && (
            <Button variant="primary" onClick={select}>
              Select car
            </Button>
          )}
          {owned && state?.damage > 0.01 && (
            <Button onClick={repair}>Repair ({Math.round(state.damage * 100)}%)</Button>
          )}
          {owned && (
            <Button
              variant="primary"
              onClick={() => {
                select()
                navigate('setup')
              }}
            >
              Race this car ▶
            </Button>
          )}
          {!owned && (
            <Button variant="primary" onClick={buy} disabled={profile.level < spec.unlockLevel || profile.credits < spec.price}>
              Buy for {formatCredits(spec.price)}
            </Button>
          )}
        </div>
      }
    >
      <div className="col garage__list scroll">
        {VEHICLE_CATALOG.map((v) => {
          const isOwned = profile.ownedCars.includes(v.id)
          const locked = profile.level < v.unlockLevel
          return (
            <div key={v.id} className={`card ${v.id === selected ? 'card--on' : ''} ${locked && !isOwned ? 'card--locked' : ''}`} onClick={() => setSelected(v.id)}>
              <div className="card__title">
                {v.brand} {v.name}
              </div>
              <div className="card__sub">{VEHICLE_CLASS_LABEL[v.vehicleClass]} · Tier {v.tier}</div>
              <div className="card__badge">{isOwned ? (profile.selectedCar === v.id ? 'Active' : 'Owned') : locked ? `Lv ${v.unlockLevel}` : formatCredits(v.price)}</div>
            </div>
          )
        })}
      </div>
      <div className="spacer" />
      <div className="col garage__detail">
        <div className="tabs">
          {(['overview', 'style', 'upgrades'] as Tab[]).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'tab--on' : ''}`} onClick={() => setTab(t)}>
              {t === 'style' ? 'Personalise' : t}
            </button>
          ))}
        </div>
        <div className="scroll" style={{ maxHeight: '70vh' }}>
          {tab === 'overview' && (
            <Panel title={`${spec.brand} ${spec.name}`}>
              <div style={{ fontStyle: 'italic', color: 'var(--cyan)', marginBottom: 6 }}>{spec.tagline}</div>
              <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginTop: 0 }}>{spec.description}</p>
              {spec.model && (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, opacity: 0.8 }}>
                  3D model: {spec.model.credit}. Livery and rims are part of the licensed model.
                </div>
              )}
              <div className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
                <Chip>{spec.engine.type === 'ev' ? 'Electric' : `${spec.engine.cylinders} cyl${spec.engine.turbo ? ' turbo' : ''}`}</Chip>
                <Chip>{spec.gearbox.drivetrain}</Chip>
                <Chip>{Math.round(tuned.mass)} kg</Chip>
                <Chip tone="accent">{ratings.powerHp} hp</Chip>
                <Chip tone="gold">{ratings.overall} OVR</Chip>
              </div>
              <StatBar label="Top speed" value={ratings.topSpeed} delta={ratings.topSpeed - baseRatings.topSpeed} display={`${ratings.topSpeedKmh}`} />
              <StatBar label="Acceleration" value={ratings.acceleration} delta={ratings.acceleration - baseRatings.acceleration} display={`${ratings.zeroToHundred}s`} />
              <StatBar label="Handling" value={ratings.handling} delta={ratings.handling - baseRatings.handling} />
              <StatBar label="Braking" value={ratings.braking} delta={ratings.braking - baseRatings.braking} />
              <StatBar label="Drift" value={ratings.drift} />
              <StatBar label="Off-road" value={ratings.offroad} />
              {state && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                  Odometer {state.odometerKm.toFixed(1)} km · Condition {Math.round((1 - state.damage) * 100)}%
                </div>
              )}
            </Panel>
          )}
          {tab === 'style' && custom && (
            <Panel title="Personalise">
              {!owned && <div style={{ color: 'var(--gold)', fontSize: 12, marginBottom: 8 }}>Preview only — buy the car to save changes.</div>}
              <Field label="Paint">
                <div className="swatches">
                  {PAINT_SWATCHES.map((s) => (
                    <div key={s.hex} title={s.name} className={`swatch ${custom.paint === s.hex ? 'swatch--on' : ''}`} style={{ background: s.hex }} onClick={() => updateCustom({ paint: s.hex })} />
                  ))}
                </div>
              </Field>
              <Field label="Accent">
                <div className="swatches">
                  {PAINT_SWATCHES.map((s) => (
                    <div key={s.hex} className={`swatch ${custom.accent === s.hex ? 'swatch--on' : ''}`} style={{ background: s.hex, width: 22, height: 22 }} onClick={() => updateCustom({ accent: s.hex, liveryColor: s.hex === custom.paint ? '#ffffff' : custom.liveryColor })} />
                  ))}
                </div>
              </Field>
              <Field label="Finish">
                <Segmented value={custom.finish} options={FINISHES.map((f) => ({ value: f, label: f }))} onChange={(finish) => updateCustom({ finish })} />
              </Field>
              <Field label="Rims">
                <Segmented value={custom.rims} options={RIM_STYLES.map((r) => ({ value: r, label: r }))} onChange={(rims) => updateCustom({ rims })} />
              </Field>
              <Field label="Rim colour">
                <div className="swatches">
                  {['#c9ccd4', '#111111', '#ffd60a', '#d0102a', '#7ef0ff', '#c8b27a', '#ffffff'].map((c) => (
                    <div key={c} className={`swatch ${custom.rimColor === c ? 'swatch--on' : ''}`} style={{ background: c, width: 22, height: 22 }} onClick={() => updateCustom({ rimColor: c })} />
                  ))}
                </div>
              </Field>
              <Field label="Tyre setup">
                <Segmented value={custom.tires} options={TIRE_STYLES.map((t) => ({ value: t, label: t }))} onChange={(tires) => updateCustom({ tires })} />
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Tyres change grip: slicks for dry tarmac, rally/winter for loose or snowy surfaces, drift for long slides.</div>
              </Field>
              <Field label="Aero wing">
                <Segmented value={custom.wing} options={WING_STYLES.map((w) => ({ value: w, label: w }))} onChange={(wing) => updateCustom({ wing })} />
              </Field>
              <Field label="Body styling">
                <Segmented value={custom.bumper} options={BUMPER_STYLES.map((b) => ({ value: b, label: b }))} onChange={(bumper) => updateCustom({ bumper })} />
              </Field>
              <Field label="Livery">
                <Segmented value={custom.livery} options={LIVERY_STYLES.map((l) => ({ value: l, label: l }))} onChange={(livery) => updateCustom({ livery })} />
              </Field>
              <Field label="Livery colour">
                <div className="swatches">
                  {['#ffffff', '#111111', '#ffd60a', '#7ef0ff', '#ff2d95', '#1fbf4a', '#ff6a00'].map((c) => (
                    <div key={c} className={`swatch ${custom.liveryColor === c ? 'swatch--on' : ''}`} style={{ background: c, width: 22, height: 22 }} onClick={() => updateCustom({ liveryColor: c })} />
                  ))}
                </div>
              </Field>
              <Field label="Window tint" value={`${Math.round(custom.windowTint * 100)}%`}>
                <Slider value={custom.windowTint} min={0} max={1} onChange={(windowTint) => updateCustom({ windowTint })} />
              </Field>
              <Field label="Race number" value={custom.raceNumber}>
                <Slider value={custom.raceNumber} min={1} max={99} step={1} onChange={(raceNumber) => updateCustom({ raceNumber })} />
              </Field>
              <Field label="Plate text">
                <input type="text" maxLength={8} value={custom.plate} onChange={(e) => updateCustom({ plate: e.target.value.toUpperCase() })} />
              </Field>
            </Panel>
          )}
          {tab === 'upgrades' && upgrades && (
            <Panel title="Mechanical upgrades">
              {!owned && <div style={{ color: 'var(--gold)', fontSize: 12, marginBottom: 8 }}>Buy the car to install upgrades.</div>}
              {UPGRADE_CATEGORIES.map((cat) => {
                const info = UPGRADE_INFO[cat]
                const level = upgrades[cat]
                const maxed = level >= MAX_UPGRADE_LEVEL
                const cost = maxed ? 0 : upgradeCost(cat, level, spec.tier)
                return (
                  <div key={cat} className="upgrade">
                    <div style={{ fontSize: 22 }}>{info.icon}</div>
                    <div>
                      <div style={{ fontWeight: 700 }}>{info.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{info.description}</div>
                      <div className="upgrade__pips">
                        {Array.from({ length: MAX_UPGRADE_LEVEL }).map((_, i) => (
                          <div key={i} className={`upgrade__pip ${i < level ? 'upgrade__pip--on' : ''}`} />
                        ))}
                      </div>
                    </div>
                    <Button size="small" sound="none" disabled={!owned || maxed || profile.credits < cost} onClick={() => buyUpgrade(cat)}>
                      {maxed ? 'MAX' : <span className="price">{formatCredits(cost)}</span>}
                    </Button>
                  </div>
                )
              })}
            </Panel>
          )}
        </div>
      </div>
    </Screen>
  )
}
