/**
 * Mobile control overlay. Writes directly into the InputManager's touch state.
 */

import { useCallback } from 'react'
import { Engine } from '../../game/core/Engine'
import type { TouchLayout } from '../../game/core/Settings'

export function TouchControls({ layout }: { layout: TouchLayout }) {
  const input = Engine.get().input
  const bind = useCallback(
    (set: (on: boolean) => void) => ({
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault()
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        set(true)
      },
      onPointerUp: () => set(false),
      onPointerCancel: () => set(false),
      onPointerLeave: () => set(false),
    }),
    [],
  )
  const setSteer = (v: number) => (on: boolean) => {
    if (on) input.touch.steer = v
    else if (input.touch.steer === v) input.touch.steer = 0
  }
  const tilt = layout === 'tilt'
  return (
    <div className="touch" data-touch-control>
      {!tilt && (
        <>
          <button className="touch__btn touch__btn--big" data-touch-control style={{ left: 'calc(18px + var(--safe-left))', bottom: 'calc(28px + var(--safe-bottom))' }} {...bind(setSteer(-1))}>
            ◀
          </button>
          <button className="touch__btn touch__btn--big" data-touch-control style={{ left: 'calc(126px + var(--safe-left))', bottom: 'calc(28px + var(--safe-bottom))' }} {...bind(setSteer(1))}>
            ▶
          </button>
        </>
      )}
      <button className="touch__btn touch__btn--big" data-touch-control style={{ right: 'calc(18px + var(--safe-right))', bottom: 'calc(28px + var(--safe-bottom))' }} {...bind((on) => (input.touch.throttle = on ? 1 : 0))}>
        GAS
      </button>
      <button className="touch__btn" data-touch-control style={{ right: 'calc(126px + var(--safe-right))', bottom: 'calc(28px + var(--safe-bottom))' }} {...bind((on) => (input.touch.brake = on ? 1 : 0))}>
        BRAKE
      </button>
      <button className="touch__btn touch__btn--small" data-touch-control style={{ right: 'calc(40px + var(--safe-right))', bottom: 'calc(140px + var(--safe-bottom))' }} {...bind((on) => (input.touch.handbrake = on))}>
        E-BRK
      </button>
      <button className="touch__btn touch__btn--small" data-touch-control style={{ right: 'calc(110px + var(--safe-right))', bottom: 'calc(140px + var(--safe-bottom))' }} {...bind((on) => (input.touch.boost = on))}>
        NOS
      </button>
      <button className="touch__btn touch__btn--small" data-touch-control style={{ left: 'calc(18px + var(--safe-left))', top: 'calc(120px + var(--safe-top))' }} onClick={() => Engine.get().cycleCamera()}>
        CAM
      </button>
      <button className="touch__btn touch__btn--small" data-touch-control style={{ left: 'calc(18px + var(--safe-left))', top: 'calc(184px + var(--safe-top))' }} onClick={() => Engine.get().respawnPlayer()}>
        RESET
      </button>
      <button className="touch__btn touch__btn--small" data-touch-control style={{ right: 'calc(18px + var(--safe-right))', top: 'calc(120px + var(--safe-top))' }} onClick={() => Engine.get().togglePause()}>
        ❚❚
      </button>
    </div>
  )
}
