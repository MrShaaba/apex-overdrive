import { HUD } from './HUD'
import { PauseMenu } from './PauseMenu'
import { ReplayControls } from './ReplayControls'
import { PhotoOverlay } from './PhotoOverlay'
import { TouchControls } from './TouchControls'
import { useGameStore } from '../../game/state/GameStore'
import { useIsTouch, useProfile } from '../hooks'

export function RaceOverlay() {
  const paused = useGameStore((s) => s.paused)
  const hudVisible = useGameStore((s) => s.hudVisible)
  const replay = useGameStore((s) => s.replay.active)
  const photo = useGameStore((s) => s.photo.active)
  const phase = useGameStore((s) => s.hud.phase)
  const split = useGameStore((s) => s.split)
  const touch = useIsTouch()
  const profile = useProfile()
  return (
    <div className="screen" style={{ padding: 0, animation: 'none', pointerEvents: 'none' }}>
      {hudVisible && !replay && !photo && split === 'none' && <HUD />}
      {hudVisible && !replay && !photo && split !== 'none' && (
        <div className={`split split--${split}`} data-testid="split">
          <div className="split__view">
            <HUD player={0} scale={0.72} compact />
            <div className="split__tag">P1</div>
          </div>
          <div className="split__view">
            <HUD player={1} scale={0.72} compact />
            <div className="split__tag split__tag--p2">P2</div>
          </div>
        </div>
      )}
      {touch && !paused && !replay && !photo && phase !== 'finished' && <TouchControls layout={profile.settings.controls.touchLayout} />}
      {paused && !photo && !replay && <PauseMenu />}
      {replay && !photo && <ReplayControls />}
      {photo && <PhotoOverlay />}
    </div>
  )
}
