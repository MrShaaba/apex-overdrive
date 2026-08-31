import { Screen } from '../components/Screen'
import { Button } from '../components/Button'
import { Panel, Chip } from '../components/Controls'
import { useGameStore, navigate } from '../../game/state/GameStore'
import { Engine } from '../../game/core/Engine'
import { formatCredits, formatTime, ordinal } from '../../game/core/MathUtils'
import { getVehicleSpec } from '../../game/vehicles/VehicleCatalog'
import { GAME_MODES } from '../../game/gameplay/GameModes'
import { TRACK_BY_ID } from '../../game/tracks/TrackCatalog'

export function ResultsScreen() {
  const results = useGameStore((s) => s.results)
  const rewards = useGameStore((s) => s.rewards)
  const stars = useGameStore((s) => s.resultStars)
  const series = useGameStore((s) => s.series)
  const config = useGameStore((s) => s.raceConfig)
  const achievements = useGameStore((s) => s.unlockedAchievements)
  const challenges = useGameStore((s) => s.completedChallenges)
  const engine = Engine.get()
  if (!results || !config) return null
  const mode = GAME_MODES[config.mode]
  const track = TRACK_BY_ID[config.trackId]
  const player = results.entries.find((e) => e.isPlayer)
  const isDrift = mode.scoring === 'drift'
  const isTime = mode.scoring === 'time'
  const seriesStandings = engine.seriesStandings()
  const seriesActive = series && !series.finished
  return (
    <Screen
      title={mode.scoring === 'none' ? 'Session over' : isDrift ? 'Drift results' : isTime ? 'Time trial' : 'Race results'}
      subtitle={`${track?.name} · ${mode.title}${config.seriesRound ? ` · round ${config.seriesRound}/${config.seriesTotal}` : ''}`}
      back={null}
      overlay
      footer={
        <>
          <Button variant="ghost" onClick={() => engine.startReplay()}>
            ▶ Replay
          </Button>
          {config.eventId && (
            <Button variant="ghost" onClick={() => void engine.quitToMenu().then(() => navigate('career'))}>
              Story
            </Button>
          )}
          <Button variant="ghost" onClick={() => void engine.quitToMenu().then(() => navigate('garage'))}>
            Garage
          </Button>
          <Button onClick={() => void engine.quitToMenu()}>Menu</Button>
          {seriesActive ? (
            <Button variant="primary" size="big" onClick={() => void engine.continueSeries()}>
              Next {series!.kind === 'knockout' ? 'heat' : 'round'} ▶
            </Button>
          ) : (
            <Button variant="primary" size="big" onClick={() => { engine.endSeries(); void engine.restartRace() }}>
              Race again ▶
            </Button>
          )}
        </>
      }
    >
      <div className="col" style={{ width: 340, flexShrink: 0 }}>
        <Panel>
          {mode.scoring === 'position' && <div className="results__pos">{ordinal(results.playerPosition)}</div>}
          {isDrift && <div className="results__pos" style={{ fontSize: 'clamp(40px, 6vw, 80px)' }}>{Math.round(results.driftScore).toLocaleString()}</div>}
          {isTime && <div className="results__pos" style={{ fontSize: 'clamp(40px, 6vw, 72px)' }}>{formatTime(results.playerBestLap)}</div>}
          {config.eventId && <div className="results__stars">{'★'.repeat(stars)}{'☆'.repeat(3 - stars)}</div>}
          <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            {isFinite(results.playerBestLap) && <Chip tone={results.isPersonalBest ? 'gold' : undefined}>Best lap {formatTime(results.playerBestLap)}{results.isPersonalBest ? ' · PB' : ''}</Chip>}
            {player && <Chip>Damage {Math.round(player.damage * 100)}%</Chip>}
            {player?.eliminated && <Chip tone="accent">Eliminated</Chip>}
          </div>
        </Panel>
        {rewards && (
          <Panel title="Payout">
            {rewards.positionCredits > 0 && <div className="reward"><span>Finishing position</span><span className="num">{formatCredits(rewards.positionCredits)}</span></div>}
            <div className="reward"><span>Laps</span><span className="num">{formatCredits(rewards.lapCredits)}</span></div>
            {rewards.driftCredits > 0 && <div className="reward"><span>Drift</span><span className="num">{formatCredits(rewards.driftCredits)}</span></div>}
            {rewards.cleanBonus > 0 && <div className="reward"><span>Clean driving</span><span className="num">{formatCredits(rewards.cleanBonus)}</span></div>}
            {rewards.difficultyBonus !== 0 && <div className="reward"><span>Difficulty</span><span className="num">{formatCredits(rewards.difficultyBonus)}</span></div>}
            {rewards.sponsorCredits > 0 && <div className="reward"><span>Sponsors</span><span className="num">{formatCredits(rewards.sponsorCredits)}</span></div>}
            {rewards.repairCost > 0 && <div className="reward" style={{ color: 'var(--red)' }}><span>Repairs</span><span className="num">-{formatCredits(rewards.repairCost)}</span></div>}
            <div className="reward reward--total"><span>Total</span><span className="num">{formatCredits(rewards.totalCredits - rewards.repairCost)}</span></div>
            <div className="reward"><span>Experience</span><span className="num" style={{ color: 'var(--cyan)' }}>+{rewards.xp} XP{rewards.levelAfter > rewards.levelBefore ? ` · LEVEL ${rewards.levelAfter}!` : ''}</span></div>
            {rewards.unlocks.map((u) => (
              <div key={u.id} className="reward" style={{ color: 'var(--gold)' }}><span>🔓 {u.title}</span></div>
            ))}
            {rewards.sponsorsCompleted.map((s) => (
              <div key={s.id} className="reward" style={{ color: 'var(--gold)' }}><span>🤝 {s.brand} contract complete +{formatCredits(s.reward)}</span></div>
            ))}
            {achievements.map((a) => (
              <div key={a.id} className="reward" style={{ color: 'var(--green)' }}><span>{a.icon} {a.title}</span><span>+{a.xp} XP</span></div>
            ))}
            {challenges.map((c) => (
              <div key={c.id} className="reward" style={{ color: 'var(--green)' }}><span>🎯 {c.title}</span><span>+{formatCredits(c.reward)}</span></div>
            ))}
          </Panel>
        )}
      </div>
      <div className="col" style={{ flex: 1, minWidth: 0 }}>
        <Panel title="Classification" className="scroll" tight>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Driver</th>
                <th>Car</th>
                <th>{isDrift ? 'Points' : 'Time'}</th>
                <th>Best lap</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {results.entries.map((e) => (
                <tr key={e.vehicleId} className={e.isPlayer ? 'is-player' : ''}>
                  <td className="num">{e.position}</td>
                  <td>{e.name}</td>
                  <td>{getVehicleSpec(e.carId).name}</td>
                  <td className="num">{isDrift ? Math.round(e.driftScore).toLocaleString() : e.finished ? formatTime(e.totalTime) : e.eliminated ? 'OUT' : 'DNF'}</td>
                  <td className="num">{isFinite(e.bestLap) ? formatTime(e.bestLap) : '—'}</td>
                  <td style={{ color: 'var(--muted)' }}>{e.eliminated ? '💀' : e.finished ? '🏁' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        {series && seriesStandings.length > 0 && (
          <Panel title={series.kind === 'knockout' ? `Knockout — ${series.finished ? 'final result' : `after heat ${series.round}`}` : `Season cup — ${series.finished ? 'final standings' : `after round ${series.round}`}`} tight className="scroll" >
            <table className="table">
              <tbody>
                {seriesStandings.slice(0, 14).map((s, i) => (
                  <tr key={s.name} className={s.name === engine.profile.playerName ? 'is-player' : ''} style={{ opacity: s.eliminated ? 0.45 : 1 }}>
                    <td className="num">{i + 1}</td>
                    <td>{s.name}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{series.kind === 'knockout' ? (s.eliminated ? 'Out' : 'Through') : `${s.points} pts`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>
    </Screen>
  )
}
