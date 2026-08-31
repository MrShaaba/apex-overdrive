import { useEffect, useState } from 'react'
import { Screen } from '../components/Screen'
import { Button } from '../components/Button'
import { Panel, Chip } from '../components/Controls'
import { useProfile } from '../hooks'
import { VEHICLE_CATALOG, VEHICLE_CLASS_LABEL } from '../../game/vehicles/VehicleCatalog'
import { computeRatings } from '../../game/vehicles/VehicleSpec'
import { Engine } from '../../game/core/Engine'
import { downloadPhoto } from '../../game/gameplay/PhotoMode'
import { saveManager } from '../../game/persistence/SaveManager'
import { bumpProfile } from '../../game/state/GameStore'

export function GalleryScreen() {
  const profile = useProfile()
  const [index, setIndex] = useState(() => Math.max(0, VEHICLE_CATALOG.findIndex((v) => v.id === profile.selectedCar)))
  const [viewing, setViewing] = useState<string | null>(null)
  const car = VEHICLE_CATALOG[index]
  const ratings = computeRatings(car)
  useEffect(() => {
    Engine.get().setShowcaseCar(car.id)
  }, [car.id])
  const remove = (url: string) => {
    saveManager.update((p) => {
      p.photos = p.photos.filter((x) => x !== url)
    })
    bumpProfile()
    setViewing(null)
  }
  return (
    <Screen title="Gallery" subtitle="Car showcase & photo mode shots">
      <div className="col" style={{ width: 360, flexShrink: 0 }}>
        <Panel title="Showcase">
          <div className="row">
            <Button size="small" onClick={() => setIndex((i) => (i - 1 + VEHICLE_CATALOG.length) % VEHICLE_CATALOG.length)}>
              ◀
            </Button>
            <div style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, textTransform: 'uppercase' }}>
                {car.brand} {car.name}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{VEHICLE_CLASS_LABEL[car.vehicleClass]}</div>
            </div>
            <Button size="small" onClick={() => setIndex((i) => (i + 1) % VEHICLE_CATALOG.length)}>
              ▶
            </Button>
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{car.description}</p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Chip>{ratings.powerHp} hp</Chip>
            <Chip>{ratings.topSpeedKmh} km/h</Chip>
            <Chip>0–100 {ratings.zeroToHundred}s</Chip>
            <Chip>{car.mass} kg</Chip>
            <Chip tone={profile.ownedCars.includes(car.id) ? 'accent' : undefined}>{profile.ownedCars.includes(car.id) ? 'In your garage' : `Unlocks at level ${car.unlockLevel}`}</Chip>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Drag on the background to rotate. Scroll to spin.</div>
        </Panel>
      </div>
      <div className="spacer" />
      <div className="col" style={{ width: 420, flexShrink: 0 }}>
        <Panel title={`Photos (${profile.photos.length})`} className="scroll">
          {profile.photos.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12 }}>Press F during a race to open photo mode. Captures appear here.</div>}
          <div className="photos">
            {profile.photos.map((p, i) => (
              <img key={i} src={p} alt={`Photo ${i + 1}`} onClick={() => setViewing(p)} />
            ))}
          </div>
        </Panel>
      </div>
      {viewing && (
        <div className="overlay" onClick={() => setViewing(null)}>
          <div className="panel overlay__box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '90vw' }}>
            <img src={viewing} alt="Photo" style={{ maxWidth: '86vw', maxHeight: '70vh', borderRadius: 8, display: 'block' }} />
            <div className="row" style={{ marginTop: 10 }}>
              <Button onClick={() => downloadPhoto(viewing)}>Download</Button>
              <Button variant="danger" onClick={() => remove(viewing)}>
                Delete
              </Button>
              <span className="spacer" />
              <Button variant="ghost" sound="back" onClick={() => setViewing(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </Screen>
  )
}
