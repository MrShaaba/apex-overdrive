/**
 * Online hub. All services run through the `NetworkProvider` contract; the
 * shipped provider is offline, so this screen demonstrates the flows
 * (matchmaking queue, invite-only rooms, friends, voice, ghosts) against the
 * local implementation.
 */

import { useEffect, useState } from 'react'
import { Screen } from '../components/Screen'
import { Button } from '../components/Button'
import { Panel, Chip } from '../components/Controls'
import { network, type Friend, type Lobby, type MatchTicket, type VoiceState } from '../../game/net'
import { useProfile } from '../hooks'
import { TRACK_CATALOG } from '../../game/tracks/TrackCatalog'
import { formatTime } from '../../game/core/MathUtils'

export function MultiplayerScreen() {
  const profile = useProfile()
  const [ticket, setTicket] = useState<MatchTicket | null>(null)
  const [lobby, setLobby] = useState<Lobby | null>(null)
  const [code, setCode] = useState('')
  const [friends, setFriends] = useState<Friend[]>([])
  const [friendName, setFriendName] = useState('')
  const [voice, setVoice] = useState<VoiceState>(network.voice.state())
  useEffect(() => {
    void network.friends.list().then(setFriends)
  }, [])
  useEffect(() => {
    if (!ticket || ticket.status !== 'queued') return
    const id = window.setInterval(() => void network.matchmaking.poll(ticket.id).then((t) => t && setTicket({ ...t })), 1000)
    return () => clearInterval(id)
  }, [ticket])
  const ghosts = Object.entries(profile.ghosts)
  return (
    <Screen title="Online" subtitle={`Status: ${network.status} · Rating ${profile.rating.elo}`}>
      <div className="col scroll" style={{ flex: 1 }}>
        <Panel title="Matchmaking">
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0 }}>Queue for a ranked race. The offline provider simulates the queue and times out — plug in a server to fill it with real drivers.</p>
          {ticket ? (
            <div className="row">
              <Chip tone={ticket.status === 'queued' ? 'accent' : undefined}>{ticket.status}</Chip>
              <span style={{ fontSize: 12 }}>Ticket {ticket.id} · est. {ticket.estimatedWaitSec}s</span>
              <span className="spacer" />
              <Button size="small" variant="ghost" onClick={() => void network.matchmaking.cancel(ticket.id).then(() => setTicket(null))}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="primary" onClick={() => void network.matchmaking.enqueue('quick', TRACK_CATALOG[0].id).then(setTicket)}>
              Find a race
            </Button>
          )}
        </Panel>
        <Panel title="Invite-only rooms">
          {lobby ? (
            <div>
              <div className="row">
                <span>Room code</span>
                <b style={{ fontFamily: 'var(--font-display)', fontSize: 24, letterSpacing: '0.2em' }}>{lobby.code}</b>
                <Chip>{lobby.mode}</Chip>
                <Chip>{lobby.players.length}/{lobby.maxPlayers}</Chip>
                <span className="spacer" />
                <Button size="small" variant="ghost" onClick={() => void network.lobbies.leave(lobby.code).then(() => setLobby(null))}>
                  Leave
                </Button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <Chip tone={voice.connected ? 'accent' : undefined}>Voice {voice.available ? (voice.connected ? 'connected' : 'available') : 'unavailable'}</Chip>
                <Button size="small" onClick={() => void network.voice.join(lobby.code).then(setVoice)}>
                  Join voice
                </Button>
                <Button size="small" variant="ghost" onClick={() => { network.voice.setMuted(!voice.muted); setVoice(network.voice.state()) }}>
                  {voice.muted ? 'Unmute' : 'Mute'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Button onClick={() => void network.lobbies.create({ mode: 'quick', trackId: TRACK_CATALOG[0].id, laps: 3, maxPlayers: 14, inviteOnly: true }).then(setLobby)}>
                Create room
              </Button>
              <input type="text" placeholder="Room code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ width: 140 }} />
              <Button variant="ghost" onClick={() => void network.lobbies.join(code).then((l) => setLobby(l))}>
                Join
              </Button>
            </div>
          )}
        </Panel>
        <Panel title="Time-trial ghosts">
          {ghosts.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Set a lap in Solo Lap Challenge to record a ghost.</div>}
          {ghosts.map(([tid, g]) => (
            <div key={tid} className="row" style={{ fontSize: 12, padding: '4px 0' }}>
              <span>{TRACK_CATALOG.find((t) => t.id === tid)?.name}</span>
              <span className="spacer" />
              <span className="num" style={{ color: 'var(--gold)' }}>{formatTime(g.lapTime)}</span>
              <Chip>{g.samples.length / 7} samples</Chip>
            </div>
          ))}
        </Panel>
      </div>
      <div className="col" style={{ width: 320, flexShrink: 0 }}>
        <Panel title="Contacts">
          <div className="row">
            <input type="text" placeholder="Add by name" value={friendName} onChange={(e) => setFriendName(e.target.value)} style={{ flex: 1 }} />
            <Button size="small" disabled={!friendName.trim()} onClick={() => void network.friends.add(friendName.trim()).then(() => { setFriendName(''); void network.friends.list().then(setFriends) })}>
              Add
            </Button>
          </div>
          {friends.map((f) => (
            <div key={f.id} className="row" style={{ fontSize: 13, padding: '6px 0' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: f.avatarColor }} />
              <span>{f.name}</span>
              <Chip>{f.status}</Chip>
              <span className="spacer" />
              <Button size="small" variant="ghost" onClick={() => void network.friends.remove(f.id).then(() => void network.friends.list().then(setFriends))}>
                ✕
              </Button>
            </div>
          ))}
        </Panel>
      </div>
    </Screen>
  )
}
