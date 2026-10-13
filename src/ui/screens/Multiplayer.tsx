/** Local racing entry point. Online transport contracts remain available in game/net. */
import { Screen } from '../components/Screen'
import { Button } from '../components/Button'
import { Panel, Chip } from '../components/Controls'
import { useProfile } from '../hooks'
import { TRACK_CATALOG } from '../../game/tracks/TrackCatalog'
import { formatTime } from '../../game/core/MathUtils'
import { navigate } from '../../game/state/GameStore'

export function MultiplayerScreen() {
  const profile = useProfile()
  const ghosts = Object.entries(profile.ghosts)
  return (
    <Screen title="Local racing" subtitle="Share a screen. Race your best lap.">
      <div className="col scroll" style={{ flex: 1 }}>
        <Panel title="Two players, one computer">
          <p>Connect two controllers, or share a wheel and keyboard. Choose Race → Two players, then pick a stacked or side-by-side view.</p>
          <div className="row">
            <Button variant="primary" onClick={() => navigate('setup')}>Set up a race</Button>
            <Button onClick={() => navigate('options')}>Configure controllers</Button>
          </div>
        </Panel>
        <Panel title="Time-trial ghosts">
          <p>Complete a clean time-trial lap to record a ghost. Race it again to improve your line and braking points.</p>
          {ghosts.length === 0 && <div className="hint">Your recorded laps will appear here.</div>}
          {ghosts.map(([id, ghost]) => (
            <div key={id} className="row" style={{ padding: '8px 0' }}>
              <span>{TRACK_CATALOG.find((t) => t.id === id)?.name ?? id}</span>
              <span className="spacer" />
              <Chip tone="gold">{formatTime(ghost.lapTime)}</Chip>
            </div>
          ))}
        </Panel>
        <Panel title="Online racing">
          <p className="hint">Online races and voice chat are not available in this build. Local split screen and saved ghosts work without an account.</p>
        </Panel>
      </div>
    </Screen>
  )
}
