import { useEffect, useMemo, useState } from 'react'
import { Screen } from '../components/Screen'
import { Panel, Segmented } from '../components/Controls'
import { useProfile } from '../hooks'
import { useGameStore } from '../../game/state/GameStore'
import { TRACK_CATALOG } from '../../game/tracks/TrackCatalog'
import { leaderboards, type LeaderboardScope } from '../../game/gameplay/Leaderboards'
import { getVehicleSpec } from '../../game/vehicles/VehicleCatalog'
import { formatTime } from '../../game/core/MathUtils'
import { network, type PlayerIdentity } from '../../game/net'

export function RankingsScreen() {
  const profile = useProfile()
  const version = useGameStore((s) => s.profileVersion)
  const [trackId, setTrackId] = useState(TRACK_CATALOG[0].id)
  const [scope, setScope] = useState<LeaderboardScope>('lap')
  const [ladder, setLadder] = useState<PlayerIdentity[]>([])
  useEffect(() => {
    void network.ratings.leaderboard(12).then(setLadder)
  }, [profile.rating.elo])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => leaderboards.get(trackId, scope), [trackId, scope, version])
  return (
    <Screen title="Rankings" subtitle={`Competitive rating ${profile.rating.elo} · ${profile.rating.wins}W / ${profile.rating.losses}L`}>
      <div className="col" style={{ flex: 1, minWidth: 0 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Segmented value={trackId} options={TRACK_CATALOG.map((t) => ({ value: t.id, label: t.name }))} onChange={setTrackId} />
        </div>
        <div className="row">
          <Segmented<LeaderboardScope> value={scope} options={[{ value: 'lap', label: 'Best lap' }, { value: 'drift', label: 'Drift score' }]} onChange={setScope} />
        </div>
        <Panel title={scope === 'lap' ? 'Lap records' : 'Drift records'} className="scroll" tight>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Driver</th>
                <th>Car</th>
                <th>{scope === 'lap' ? 'Time' : 'Points'}</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.name}-${i}`} className={r.isPlayer ? 'is-player' : ''}>
                  <td className="num">{i + 1}</td>
                  <td>{r.name}</td>
                  <td>{getVehicleSpec(r.carId).name}</td>
                  <td className="num">{scope === 'lap' ? formatTime(r.time) : Math.round(r.time).toLocaleString()}</td>
                  <td style={{ color: 'var(--muted)' }}>{new Date(r.date).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <div className="col" style={{ width: 320, flexShrink: 0 }}>
        <Panel title="Rating ladder" tight>
          <table className="table">
            <tbody>
              {ladder.map((p, i) => (
                <tr key={p.id} className={p.id === 'local-player' ? 'is-player' : ''}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: p.avatarColor, marginRight: 8 }} />
                    {p.name}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {p.rating}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Your records" tight>
          {Object.keys(profile.records).length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12 }}>No lap records yet — finish a lap to set one.</div>}
          {Object.entries(profile.records).map(([tid, rec]) => (
            <div key={tid} className="row" style={{ fontSize: 12, padding: '4px 0' }}>
              <span>{TRACK_CATALOG.find((t) => t.id === tid)?.name ?? tid}</span>
              <span className="spacer" />
              <span className="num" style={{ color: 'var(--gold)' }}>
                {formatTime(rec.time)}
              </span>
            </div>
          ))}
        </Panel>
      </div>
    </Screen>
  )
}
