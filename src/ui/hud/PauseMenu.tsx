import { Button } from '../components/Button'
import { Engine } from '../../game/core/Engine'
import { useGameStore } from '../../game/state/GameStore'
import type { CameraMode } from '../../game/core/Settings'
import { Segmented } from '../components/Controls'
import { useProfile } from '../hooks'
import { formatCredits } from '../../game/core/MathUtils'

export function PauseMenu() {
  const engine = Engine.get()
  const cam = useGameStore((s) => s.hud.cameraMode)
  const damage = useGameStore((s) => s.hud.damage)
  const mode = useGameStore((s) => s.hud.mode)
  const profile = useProfile()
  const repairCost = Math.round(damage * 2500 + 250)
  return (
    <div className="overlay">
      <div className="panel overlay__box">
        <h2 className="pause__title">Paused</h2>
        <div className="pause__nav">
          <Button variant="primary" onClick={() => engine.resume()}>
            Resume
          </Button>
          <Button onClick={() => engine.enterPhotoMode()}>Photo mode</Button>
          <Button onClick={() => void engine.restartRace()}>Restart</Button>
          {damage > 0.05 && mode !== 'endurance' && (
            <Button disabled={profile.credits < repairCost} onClick={() => engine.repairPlayerNow()}>
              Repair now ({formatCredits(repairCost)})
            </Button>
          )}
          <Button variant="ghost" onClick={() => engine.finishRaceEarly()}>
            Retire from session
          </Button>
          <Button variant="danger" sound="back" onClick={() => void engine.quitToMenu()}>
            Quit to menu
          </Button>
        </div>
        <div style={{ marginTop: 14 }}>
          <div className="field__label" style={{ marginBottom: 6 }}>
            Camera
          </div>
          <Segmented<CameraMode> value={cam} options={(['chase', 'chaseFar', 'hood', 'cockpit', 'cinematic'] as CameraMode[]).map((v) => ({ value: v, label: v }))} onChange={(m) => engine.setCamera(m)} />
        </div>
      </div>
    </div>
  )
}
