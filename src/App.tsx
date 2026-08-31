/**
 * Root UI shell. Mounts the WebGL canvas once, boots the engine and routes
 * between screens based on the game store. Everything visual in the game world
 * is rendered by the engine; React only draws menus, HUD and overlays.
 */

import { useEffect, useRef } from 'react'
import { Engine } from './game/core/Engine'
import { useGameStore } from './game/state/GameStore'
import { Toasts } from './ui/components/Toasts'
import { BootScreen } from './ui/screens/Loading'
import { MainMenu } from './ui/screens/MainMenu'
import { CareerScreen } from './ui/screens/Career'
import { GarageScreen } from './ui/screens/Garage'
import { RaceSetupScreen } from './ui/screens/RaceSetup'
import { RankingsScreen } from './ui/screens/Rankings'
import { GalleryScreen } from './ui/screens/Gallery'
import { OptionsScreen } from './ui/screens/Options'
import { StatsScreen } from './ui/screens/Stats'
import { ResultsScreen } from './ui/screens/Results'
import { MultiplayerScreen } from './ui/screens/Multiplayer'
import { RaceOverlay } from './ui/hud/RaceOverlay'

let booted = false

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const screen = useGameStore((s) => s.screen)

  useEffect(() => {
    if (booted || !canvasRef.current) return
    booted = true
    void Engine.get().init(canvasRef.current)
  }, [])

  return (
    <>
      <canvas id="game-canvas" ref={canvasRef} />
      <div className="ui-root">
        {(screen === 'boot' || screen === 'loading') && <BootScreen />}
        {screen === 'menu' && <MainMenu />}
        {screen === 'career' && <CareerScreen />}
        {screen === 'garage' && <GarageScreen />}
        {screen === 'setup' && <RaceSetupScreen />}
        {screen === 'rankings' && <RankingsScreen />}
        {screen === 'gallery' && <GalleryScreen />}
        {screen === 'options' && <OptionsScreen />}
        {screen === 'stats' && <StatsScreen />}
        {screen === 'multiplayer' && <MultiplayerScreen />}
        {screen === 'race' && <RaceOverlay />}
        {screen === 'results' && <ResultsScreen />}
        <Toasts />
      </div>
    </>
  )
}
