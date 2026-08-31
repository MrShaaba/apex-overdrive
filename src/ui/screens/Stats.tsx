import { useMemo } from 'react'
import { Screen } from '../components/Screen'
import { Button } from '../components/Button'
import { Panel, Chip } from '../components/Controls'
import { useProfile } from '../hooks'
import { ACHIEVEMENTS } from '../../game/gameplay/Achievements'
import { currentChallenges, challengeProgress } from '../../game/gameplay/Challenges'
import { SPONSORS, rankTitle, xpForLevel } from '../../game/gameplay/Progression'
import { saveManager } from '../../game/persistence/SaveManager'
import { bumpProfile, pushToast } from '../../game/state/GameStore'
import { formatCredits } from '../../game/core/MathUtils'
import { GAME_MODES } from '../../game/gameplay/GameModes'

export function StatsScreen() {
  const profile = useProfile()
  const s = profile.stats
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const challenges = useMemo(() => currentChallenges(), [profile.challenges.period])
  const activate = (id: string) => {
    if (profile.sponsors.active.length >= 3) {
      pushToast('Maximum three active contracts', '⚠️')
      return
    }
    saveManager.update((p) => {
      if (!p.sponsors.active.includes(id)) p.sponsors.active.push(id)
    })
    bumpProfile()
  }
  const drop = (id: string) => {
    saveManager.update((p) => {
      p.sponsors.active = p.sponsors.active.filter((x) => x !== id)
    })
    bumpProfile()
  }
  const hours = Math.floor(s.timePlayedSec / 3600)
  const mins = Math.floor((s.timePlayedSec % 3600) / 60)
  return (
    <Screen title="Driver" subtitle={`${profile.playerName} · Level ${profile.level} ${rankTitle(profile.level)} · ${profile.xp.toLocaleString()} XP (next at ${xpForLevel(profile.level + 1).toLocaleString()})`}>
      <div className="col scroll" style={{ width: 340, flexShrink: 0 }}>
        <Panel title="Statistics" tight>
          {[
            ['Races entered', s.racesEntered],
            ['Wins', s.racesWon],
            ['Podiums', s.podiums],
            ['Laps completed', s.lapsCompleted],
            ['Distance', `${s.distanceKm.toFixed(1)} km`],
            ['Top speed', `${Math.round(s.topSpeedKmh)} km/h`],
            ['Drift points', Math.round(s.driftPointsTotal).toLocaleString()],
            ['Overtakes', s.overtakes],
            ['Collisions', s.crashes],
            ['Credits earned', formatCredits(s.creditsEarned)],
            ['Time played', `${hours}h ${mins}m`],
          ].map(([k, v]) => (
            <div key={String(k)} className="row" style={{ fontSize: 13, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <span style={{ color: 'var(--muted)' }}>{k}</span>
              <span className="spacer" />
              <b className="num">{v}</b>
            </div>
          ))}
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Best finish by mode</div>
          <div className="row" style={{ flexWrap: 'wrap', marginTop: 4 }}>
            {Object.entries(s.bestFinishByMode).map(([m, pos]) => (
              <Chip key={m}>
                {GAME_MODES[m as keyof typeof GAME_MODES]?.title ?? m}: P{pos}
              </Chip>
            ))}
          </div>
        </Panel>
        <Panel title="Rotating challenges" tight>
          {challenges.map((c) => {
            const p = challengeProgress(c)
            const done = profile.challenges.completed.includes(c.id)
            return (
              <div key={c.id} style={{ fontSize: 12, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="row">
                  <Chip tone={c.period === 'weekly' ? 'gold' : undefined}>{c.period}</Chip>
                  <b>{c.title}</b>
                  <span className="spacer" />
                  <span style={{ color: done ? 'var(--green)' : 'var(--muted)' }}>{done ? 'Complete' : `${Math.min(p, c.target).toLocaleString()} / ${c.target.toLocaleString()}`}</span>
                </div>
                <div style={{ color: 'var(--muted)' }}>
                  {c.description} · {formatCredits(c.reward)} · {c.xp} XP
                </div>
              </div>
            )
          })}
        </Panel>
      </div>
      <div className="col scroll" style={{ flex: 1 }}>
        <Panel title="Sponsor contracts" tight>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Sign up to three contracts. Each pays a per-race bonus and a completion reward.</div>
          {SPONSORS.map((sp) => {
            const active = profile.sponsors.active.includes(sp.id)
            const done = profile.sponsors.completed.includes(sp.id)
            const locked = profile.level < sp.requirementLevel
            const progress = profile.sponsors.progress[sp.id] ?? 0
            return (
              <div key={sp.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.06)', opacity: locked ? 0.5 : 1 }}>
                <div style={{ width: 8, alignSelf: 'stretch', background: sp.color, borderRadius: 2 }} />
                <div style={{ flex: 1 }}>
                  <div>
                    <b>{sp.brand}</b> <span style={{ color: 'var(--muted)', fontSize: 12 }}>— {sp.tagline}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {sp.objective.label} · {formatCredits(sp.reward)} + {formatCredits(sp.perRaceBonus)}/race {locked && `· Level ${sp.requirementLevel}`}
                  </div>
                  {active && <div style={{ fontSize: 11, color: 'var(--cyan)' }}>Progress {Math.min(progress, sp.objective.target).toLocaleString()} / {sp.objective.target.toLocaleString()}</div>}
                </div>
                {done ? <Chip tone="gold">Complete</Chip> : active ? <Button size="small" variant="ghost" onClick={() => drop(sp.id)}>Drop</Button> : <Button size="small" disabled={locked} onClick={() => activate(sp.id)}>Sign</Button>}
              </div>
            )
          })}
        </Panel>
        <Panel title={`Accomplishments (${profile.achievements.length}/${ACHIEVEMENTS.length})`} tight>
          <div className="grid-3">
            {ACHIEVEMENTS.map((a) => {
              const got = profile.achievements.includes(a.id)
              return (
                <div key={a.id} className={`card ${got ? 'card--on' : 'card--locked'}`} style={{ cursor: 'default' }}>
                  <div className="card__title">
                    {a.icon} {a.title}
                  </div>
                  <div className="card__sub">{a.description}</div>
                  <div className="card__badge">{a.xp} XP</div>
                </div>
              )
            })}
          </div>
        </Panel>
      </div>
    </Screen>
  )
}
