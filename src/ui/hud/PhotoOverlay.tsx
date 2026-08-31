import { Button } from '../components/Button'
import { Engine } from '../../game/core/Engine'
import { useGameStore } from '../../game/state/GameStore'
import { downloadPhoto } from '../../game/gameplay/PhotoMode'

export function PhotoOverlay() {
  const photo = useGameStore((s) => s.photo)
  const engine = Engine.get()
  return (
    <div className="photo-ui">
      <div className="photo-ui__frame" />
      <div className="photo-ui__hint">Photo mode · drag to orbit · scroll to zoom</div>
      <div className="photo-ui__bar panel panel--tight">
        <Button size="small" onClick={() => engine.photoCameraFov(-5)}>
          Zoom +
        </Button>
        <Button size="small" onClick={() => engine.photoCameraFov(5)}>
          Zoom −
        </Button>
        <Button variant="primary" onClick={() => engine.capturePhoto()}>
          📷 Capture
        </Button>
        {photo.lastCapture && (
          <Button size="small" onClick={() => downloadPhoto(photo.lastCapture!)}>
            Download last
          </Button>
        )}
        <Button size="small" variant="ghost" sound="back" onClick={() => engine.exitPhotoMode()}>
          Exit
        </Button>
      </div>
    </div>
  )
}
