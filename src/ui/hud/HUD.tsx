/**
 * Race HUD: position, laps, timers, speedo/tach, route map, standings,
 * nitro/fuel/damage/turbo bars, drift score, countdown and messages.
 */

import { useMemo } from 'react'
import { useGameStore } from '../../game/state/GameStore'
import { Speedometer } from './Speedometer'
import { Minimap } from './Minimap'
import { Engine } from '../../game/core/Engine'
import { formatTime } from '../../game/core/MathUtils'
import { useProfile } from '../hooks'
import { WEATHER_LABEL, type WeatherKind } from '../../game/tracks/TrackCatalog'

export function HUD() {
  const hud = useGameStore((s) => s.hud)
  const messages = useGameStore((s) => s.messages)
  const profile = useProfile()
  const units = profile.settings.controls.units
  const showFps = profile.settings.graphics.showFps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const minimapData = useMemo(() => Engine.get().getMinimap(), [hud.mode, hud.totalLaps])
  const isDrift = hud.mode === 'drift'
  const isTT = hud.mode === 'timetrial'
  const isFree = hud.mode === 'freeroam'
  const isElim = hud.mode === 'elimination'
  const hour = Math.floor(hud.hour)
  const minute = Math.floor((hud.hour - hour) * 60)
  const standings = hud.standings.slice(0, 8)
  const playerIdx = hud.standings.findIndex((s) => s.isPlayer)
  const shown = standings.some((s) => s.isPlayer) || playerIdx < 0 ? standings : [...standings.slice(0, 7), hud.standings[playerIdx]]
  return (
    <div className="hud" style={{ transform: `scale(${profile.settings.gameplay.hudScale})` }}>
      {/* Top-left: position & lap */}
      <div className="hud__corner hud__tl">
        {!isFree && (
          <div className="hud__box">
            {!isDrift && !isTT && (
              <div className="hud__pos">
                <span className="hud__pos-num">{hud.position}</span>
                <span className="hud__pos-of">/ {hud.total}</span>
              </div>
            )}
            {isDrift && (
              <>
                <div className="hud__label">Banked</div>
                <div className="hud__value hud__value--big" style={{ color: 'var(--gold)' }}>
                  {hud.driftBanked.toLocaleString()}
                </div>
              </>
            )}
            <div className="hud__label">Lap</div>
            <div className="hud__value">
              {Math.max(1, Math.min(hud.lap + 1, hud.totalLaps))} <span style={{ color: 'var(--muted)', fontSize: 14 }}>/ {hud.totalLaps}</span>
            </div>
            {hud.seriesRound && <div className="hud__chip">{hud.seriesRound}</div>}
          </div>
        )}
        {isElim && hud.phase === 'racing' && (
          <div className="hud__box">
            <div className="hud__label">Elimination in</div>
            <div className="hud__elim">{hud.eliminationTimer.toFixed(1)}s</div>
          </div>
        )}
        {hud.inPit && <div className="hud__chip" style={{ color: 'var(--green)' }}>🔧 PIT — repairing & refuelling</div>}
      </div>

      {/* Top-right: timers */}
      <div className="hud__corner hud__tr">
        {!isFree && (
          <div className="hud__box" style={{ textAlign: 'right' }}>
            <div className="hud__label">Lap time</div>
            <div className="hud__value num">{formatTime(hud.lapTime)}</div>
            <div className="hud__label">Best</div>
            <div className={`hud__value num ${isFinite(hud.bestLap) ? 'hud__value--good' : ''}`} style={{ fontSize: 15 }}>
              {isFinite(hud.bestLap) ? formatTime(hud.bestLap) : '--:--.---'}
            </div>
            {hud.lastLap > 0 && (
              <>
                <div className="hud__label">Last</div>
                <div className="hud__value num" style={{ fontSize: 15 }}>
                  {formatTime(hud.lastLap)}
                </div>
              </>
            )}
            <div className="hud__label">Race</div>
            <div className="hud__value num" style={{ fontSize: 15 }}>
              {formatTime(hud.raceTime)}
            </div>
            {hud.sectorTimes.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--cyan)' }} className="num">
                S: {hud.sectorTimes.map((t) => t.toFixed(1)).join(' · ')}
              </div>
            )}
          </div>
        )}
        <div className="row">
          <span className="hud__chip">
            {WEATHER_LABEL[hud.weather as WeatherKind] ?? hud.weather} · {String(hour).padStart(2, '0')}:{String(minute).padStart(2, '0')}
          </span>
          {showFps && <span className="hud__chip">{Math.round(hud.fps)} fps</span>}
        </div>
        {!isFree && !isTT && !isDrift && profile.settings.gameplay.showMinimap && (
          <div className="standings">
            {shown.map((s) => (
              <div key={s.id} className={`standings__row ${s.isPlayer ? 'standings__row--player' : ''} ${s.eliminated ? 'standings__row--out' : ''}`}>
                <span className="standings__pos">{s.position}</span>
                <span className="standings__dot" style={{ background: s.color }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                <span className="standings__gap">{s.finished ? '🏁' : s.eliminated ? 'OUT' : s.position === 1 ? 'LEADER' : `+${(s.gap / 45).toFixed(1)}s`}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Top-center: countdown, messages, wrong way */}
      <div className="hud__corner hud__tc">
        {hud.countdown > 0 && <div key={Math.ceil(hud.countdown)} className="hud__countdown">{Math.ceil(hud.countdown)}</div>}
        {hud.phase === 'racing' && hud.raceTime < 1.2 && <div className="hud__countdown hud__countdown--go">GO</div>}
        {hud.wrongWay && <div className="hud__wrongway">⚠ WRONG WAY</div>}
        {messages.map((m) => (
          <div key={m.id} className={`hud__msg hud__msg--${m.kind}`}>
            {m.text}
          </div>
        ))}
      </div>

      {/* Bottom-left: route map */}
      {profile.settings.gameplay.showMinimap && (
        <div className="hud__corner hud__bl">
          <Minimap data={minimapData} cars={hud.minimap} progress={0} />
        </div>
      )}

      {/* Bottom-center: drift + bars */}
      <div className="hud__corner hud__bc">
        {hud.drifting && hud.driftCurrent > 0 && (
          <div className="hud__drift">
            <div className="hud__drift-pts">+{hud.driftCurrent.toLocaleString()}</div>
            <div className="hud__drift-mult">×{hud.driftMultiplier.toFixed(1)} DRIFT</div>
          </div>
        )}
        <div className="hud__bars">
          <div className="hud__bar">
            <div className="hud__label">
              ERS {Math.round(hud.nitro * 100)}% {hud.boostActive ? '⚡' : hud.ersHarvest ? '⟳' : ''}
            </div>
            <div className="hud__bar-track">
              <div className={`hud__bar-fill hud__bar-fill--nitro ${hud.boostActive ? 'is-active' : ''} ${hud.ersHarvest ? 'is-harvest' : ''}`} style={{ width: `${hud.nitro * 100}%` }} />
            </div>
          </div>
          {hud.turbo > 0.01 && (
            <div className="hud__bar" style={{ width: 70 }}>
              <div className="hud__label">Turbo</div>
              <div className="hud__bar-track">
                <div className="hud__bar-fill hud__bar-fill--turbo" style={{ width: `${hud.turbo * 100}%` }} />
              </div>
            </div>
          )}
          {hud.mode === 'endurance' && (
            <div className="hud__bar">
              <div className="hud__label">Fuel {hud.fuel < 0.15 ? '⚠' : ''}</div>
              <div className="hud__bar-track">
                <div className="hud__bar-fill hud__bar-fill--fuel" style={{ width: `${hud.fuel * 100}%` }} />
              </div>
            </div>
          )}
          <div className="hud__bar">
            <div className="hud__label">Damage {Math.round(hud.damage * 100)}%</div>
            <div className="hud__bar-track">
              <div className="hud__bar-fill hud__bar-fill--damage" style={{ width: `${hud.damage * 100}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* Bottom-right: speedo */}
      <div className="hud__corner hud__br">
        <Speedometer speedKmh={hud.speedKmh} rpm={hud.rpm} redline={hud.redline} gear={hud.gear} limiter={hud.rpm >= hud.redline * 0.99} units={units} nitroActive={hud.boostActive} />
      </div>
    </div>
  )
}
