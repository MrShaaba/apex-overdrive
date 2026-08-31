import { useMemo } from 'react'
import { saveManager } from '../game/persistence/SaveManager'
import { useGameStore } from '../game/state/GameStore'

/** Re-reads the profile whenever the engine bumps `profileVersion`. */
export function useProfile() {
  const version = useGameStore((s) => s.profileVersion)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => saveManager.get(), [version])
}

export function useIsTouch(): boolean {
  return useMemo(() => typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0), [])
}
