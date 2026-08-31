import { Button } from '../components/Button'
import { Engine } from '../../game/core/Engine'
import { useGameStore } from '../../game/state/GameStore'
import { formatTime } from '../../game/core/MathUtils'

export function ReplayControls() {
  const replay = useGameStore((s) => s.replay)
  const engine = Engine.get()
  return (
    <div className="replay-bar panel panel--tight">
      <Button size="small" onClick={() => engine.setReplayPlaying(!replay.playing)}>
        {replay.playing ? '❚❚' : '▶'}
      </Button>
      <span className="num" style={{ fontSize: 12, minWidth: 70 }}>
        {formatTime(replay.time)}
      </span>
      <input type="range" min={0} max={Math.max(0.01, replay.duration)} step={0.05} value={replay.time} onChange={(e) => engine.seekReplay(parseFloat(e.target.value))} />
      <span className="num" style={{ fontSize: 12, minWidth: 70 }}>
        {formatTime(replay.duration)}
      </span>
      {[0.25, 0.5, 1, 2].map((s) => (
        <Button key={s} size="small" variant={replay.speed === s ? 'primary' : 'ghost'} onClick={() => engine.setReplaySpeed(s)}>
          {s}×
        </Button>
      ))}
      <Button size="small" onClick={() => engine.enterPhotoMode()}>
        📷
      </Button>
      <Button size="small" variant="ghost" sound="back" onClick={() => engine.stopReplay()}>
        Exit
      </Button>
    </div>
  )
}
