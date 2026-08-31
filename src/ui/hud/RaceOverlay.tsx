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
  const touch = useIsTouch()
  const profile = useProfile()
  return (
    <div className="screen" style={{ padding: 0, animation: 'none', pointerEvents: 'none' }}>
      {hudVisible && !replay && !photo && <HUD />}
      {touch && !paused && !replay && !photo && phase !== 'finished' && <TouchControls layout={profile.settings.controls.touchLayout} />}
      {paused && !photo && !replay && <PauseMenu />}
      {replay && !photo && <ReplayControls />}
      {photo && <PhotoOverlay />}
    </div>
  )
}
