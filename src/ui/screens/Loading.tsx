import { useEffect, useState } from 'react'
import { useGameStore } from '../../game/state/GameStore'
import { TRACK_BY_ID } from '../../game/tracks/TrackCatalog'

const TIPS = [
  'Brake before the apex, not in it. Trail-braking rotates the car.',
  'Handbrake (Space) plus a flick of steering starts a drift; throttle holds it.',
  'Nitrous (Shift) refills slowly — save it for the longest straight.',
  'Wet asphalt cuts grip by a quarter. Rally and winter tyres claw some back.',
  'Optional shortcuts skip checkpoints. Only required checkpoints validate a lap.',
  'The pit lane repairs damage and refuels — drive through it slowly.',
  'Press C to cycle cameras, F for photo mode, V for the replay after the finish.',
  'Rivals defend the inside line when you close in. Fake one way, go the other.',
  'Aero cars need speed to find grip. Trust the downforce in fast corners.',
  'Damage saps power and pulls the steering. Repair in the garage between races.',
  'Elimination races drop the last car every 20 seconds — never be last.',
  'Time-of-day moves during long races. Headlights switch on automatically.',
]

export function BootScreen() {
  const loading = useGameStore((s) => s.loading)
  const error = useGameStore((s) => s.bootError)
  const config = useGameStore((s) => s.raceConfig)
  const screen = useGameStore((s) => s.screen)
  const [tip, setTip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)])
  useEffect(() => {
    const id = window.setInterval(() => setTip(TIPS[Math.floor(Math.random() * TIPS.length)]), 4000)
    return () => clearInterval(id)
  }, [])
  const track = screen === 'loading' && config ? TRACK_BY_ID[config.trackId] : null
  return (
    <div className="screen boot">
      {track ? (
        <>
          <div className="boot__label">{track.location}</div>
          <div className="boot__track">{track.name}</div>
          <div className="boot__tip">{track.description}</div>
        </>
      ) : (
        <>
          <h1 className="menu__logo" style={{ fontSize: 'clamp(40px, 8vw, 84px)' }}>
            Apex <em>Overdrive</em>
          </h1>
          <div className="boot__label">Premium browser racing</div>
        </>
      )}
      {error ? (
        <div className="boot__error">
          <b>Could not start the engine.</b>
          <br />
          {error}
          <br />
          <small>Apex Overdrive needs a browser with WebGL 2 and WebAssembly. Try Chrome, Edge, Firefox or Safari 16+.</small>
        </div>
      ) : (
        <>
          <div className="boot__bar">
            <div className="boot__fill" style={{ width: `${Math.round(loading.progress * 100)}%` }} />
          </div>
          <div className="boot__label">{loading.label}</div>
          <div className="boot__tip">💡 {tip}</div>
        </>
      )}
    </div>
  )
}
