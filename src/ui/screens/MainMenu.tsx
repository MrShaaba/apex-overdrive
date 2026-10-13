import { useEffect, useMemo } from 'react'
import { Button } from '../components/Button'
import { navigate, useGameStore } from '../../game/state/GameStore'
import { useProfile, useIsTouch } from '../hooks'
import { rankTitle, xpForLevel } from '../../game/gameplay/Progression'
import { formatCredits } from '../../game/core/MathUtils'
import { currentChallenges, challengeProgress, syncChallengePeriod } from '../../game/gameplay/Challenges'
import { getVehicleSpec, VEHICLE_CATALOG } from '../../game/vehicles/VehicleCatalog'
import { TRACK_CATALOG } from '../../game/tracks/TrackCatalog'
import { Engine } from '../../game/core/Engine'

export function MainMenu() {
  const profile = useProfile()
  const audioUnlocked = useGameStore((s) => s.audioUnlocked)
  const touch = useIsTouch()
  useEffect(() => {
    syncChallengePeriod()
    Engine.get().setShowcaseCar(profile.selectedCar)
  }, [profile.selectedCar])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const challenges = useMemo(() => currentChallenges().slice(0, 3), [profile.challenges.period])
  const level = profile.level
  const xpCur = profile.xp - xpForLevel(level)
  const xpNext = xpForLevel(level + 1) - xpForLevel(level)
  const car = getVehicleSpec(profile.selectedCar)

  const items: { label: string; icon: string; sub: string; go: () => void }[] = [
    { label: 'Story', icon: '🏆', sub: `Chapter ${profile.career.chapter + 1}`, go: () => navigate('career') },
    { label: 'Race', icon: '🏁', sub: 'All modes', go: () => navigate('setup') },
    { label: 'Workshop', icon: '🔧', sub: `${profile.ownedCars.length} cars`, go: () => navigate('garage') },
    { label: 'Rankings', icon: '📊', sub: 'Leaderboards', go: () => navigate('rankings') },
    { label: 'Gallery', icon: '📸', sub: `${profile.photos.length} photos`, go: () => navigate('gallery') },
    { label: 'Driver', icon: '👤', sub: 'Stats & awards', go: () => navigate('stats') },
    { label: 'Local racing', icon: '🎮', sub: 'Two players & ghosts', go: () => navigate('multiplayer') },
    { label: 'Options', icon: '⚙️', sub: '', go: () => navigate('options') },
  ]

  return (
    <div className="screen screen--overlay menu">
      <div className="menu__brand">
        <h1 className="menu__logo">
          Apex
          <br />
          <em>Overdrive</em>
        </h1>
        <div className="menu__tag">{VEHICLE_CATALOG.length} cars · {TRACK_CATALOG.length} layouts · Your home grid</div>
      </div>
      <nav className="menu__nav">
        {items.map((it, i) => (
          <Button key={it.label} variant="menu" icon={it.icon} sub={it.sub} style={{ animationDelay: `${i * 45}ms` }} onClick={it.go}>
            {it.label}
          </Button>
        ))}
      </nav>
      <aside className="menu__side">
        <div className="profile-chip">
          <div className="profile-chip__avatar">{profile.playerName.slice(0, 1).toUpperCase()}</div>
          <div style={{ minWidth: 160 }}>
            <div className="profile-chip__name">{profile.playerName}</div>
            <div className="profile-chip__meta">
              Lv {level} · {rankTitle(level)} · {formatCredits(profile.credits)}
            </div>
            <div className="xp-bar">
              <div className="xp-bar__fill" style={{ width: `${Math.min(100, (xpCur / xpNext) * 100)}%` }} />
            </div>
          </div>
        </div>
        <div className="panel panel--tight" style={{ width: 300 }}>
          <div className="panel__title">Current ride</div>
          <div style={{ fontWeight: 700 }}>
            {car.brand} {car.name}
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>{car.tagline}</div>
        </div>
        <div className="panel panel--tight" style={{ width: 300 }}>
          <div className="panel__title">Today's challenges</div>
          {challenges.map((c) => {
            const p = challengeProgress(c)
            const done = profile.challenges.completed.includes(c.id)
            return (
              <div key={c.id} style={{ fontSize: 12, marginBottom: 6 }}>
                <div className="row">
                  <span style={{ fontWeight: 700 }}>{c.title}</span>
                  <span className="spacer" />
                  <span style={{ color: done ? 'var(--green)' : 'var(--muted)' }}>{done ? '✓' : `${Math.min(p, c.target).toLocaleString()} / ${c.target.toLocaleString()}`}</span>
                </div>
                <div style={{ color: 'var(--muted)' }}>{c.description}</div>
              </div>
            )
          })}
        </div>
      </aside>
      <div className="menu__footer">
        {!touch && (
          <>
            <span>
              <kbd>W A S D</kbd> drive
            </span>
            <span>
              <kbd>Space</kbd> handbrake
            </span>
            <span>
              <kbd>Shift</kbd> ERS boost
            </span>
            <span>
              <kbd>C</kbd> camera
            </span>
            <span>
              <kbd>F</kbd> photo
            </span>
          </>
        )}
        {!audioUnlocked && <span style={{ color: 'var(--cyan)' }}>🔈 Click or tap to enable audio</span>}
        <span className="spacer" />
        <span>v2.0 · drag to rotate the car</span>
      </div>
    </div>
  )
}
