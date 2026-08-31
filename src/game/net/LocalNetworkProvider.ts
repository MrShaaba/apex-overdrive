/**
 * Offline implementation of the network contracts.
 *
 * - Matchmaking simulates a queue and times out (no server to find peers).
 * - Lobbies are created locally with shareable invite codes.
 * - Ratings run a real Elo calculation against the AI field so a competitive
 *   rating already accrues offline and can be migrated online.
 * - Friends are stored in the save profile.
 * - Voice detects microphone availability but never transmits.
 * - Ghosts persist best laps in the profile and play back in time trials.
 */

import { saveManager } from '../persistence/SaveManager'
import { allDrivers } from '../ai/DriverProfiles'
import type {
  ConnectionStatus,
  Friend,
  GhostLap,
  Lobby,
  MatchTicket,
  NetworkProvider,
  PlayerIdentity,
  RatingResult,
  VoiceState,
} from './types'

const randomCode = (len = 6): string => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

const FRIENDS_KEY = 'friends'

export class LocalNetworkProvider implements NetworkProvider {
  status: ConnectionStatus = 'offline'
  private tickets = new Map<string, MatchTicket>()
  private lobbyMap = new Map<string, Lobby>()
  private voiceState: VoiceState = { available: false, connected: false, muted: false, speaking: false, participants: [] }

  get identity(): PlayerIdentity {
    const p = saveManager.get()
    return { id: 'local-player', name: p.playerName, rating: p.rating.elo, avatarColor: '#ff6a00' }
  }

  async connect(): Promise<ConnectionStatus> {
    this.status = 'offline'
    return this.status
  }

  async disconnect(): Promise<void> {
    this.status = 'offline'
  }

  matchmaking = {
    enqueue: async (mode: string, trackId: string): Promise<MatchTicket> => {
      const ticket: MatchTicket = { id: randomCode(8), mode, trackId, createdAt: Date.now(), status: 'queued', estimatedWaitSec: 30 }
      this.tickets.set(ticket.id, ticket)
      window.setTimeout(() => {
        const t = this.tickets.get(ticket.id)
        if (t && t.status === 'queued') t.status = 'timeout'
      }, 8000)
      return ticket
    },
    cancel: async (ticketId: string): Promise<void> => {
      const t = this.tickets.get(ticketId)
      if (t) t.status = 'cancelled'
    },
    poll: async (ticketId: string): Promise<MatchTicket | null> => this.tickets.get(ticketId) ?? null,
  }

  lobbies = {
    create: async (opts: { mode: string; trackId: string; laps: number; maxPlayers: number; inviteOnly: boolean }): Promise<Lobby> => {
      const lobby: Lobby = { code: randomCode(), hostId: this.identity.id, players: [this.identity], createdAt: Date.now(), ...opts }
      this.lobbyMap.set(lobby.code, lobby)
      return lobby
    },
    join: async (code: string): Promise<Lobby | null> => this.lobbyMap.get(code.toUpperCase()) ?? null,
    leave: async (code: string): Promise<void> => {
      this.lobbyMap.delete(code)
    },
    list: async (): Promise<Lobby[]> => [...this.lobbyMap.values()].filter((l) => !l.inviteOnly),
  }

  ratings = {
    get: async (): Promise<number> => saveManager.get().rating.elo,
    report: async (playerPosition: number, fieldSize: number, opponentRatings: number[]): Promise<RatingResult> => {
      const before = saveManager.get().rating.elo
      // Multiplayer Elo: treat every opponent as a pairwise match.
      let delta = 0
      const K = 24 / Math.max(1, fieldSize - 1)
      opponentRatings.forEach((r, i) => {
        const opponentPosition = i + 1 >= playerPosition ? i + 2 : i + 1
        const actual = playerPosition < opponentPosition ? 1 : 0
        const expected = 1 / (1 + Math.pow(10, (r - before) / 400))
        delta += K * (actual - expected)
      })
      delta = Math.round(delta)
      const after = Math.max(100, before + delta)
      const won = playerPosition === 1
      saveManager.update((p) => {
        p.rating.elo = after
        if (won) p.rating.wins++
        else p.rating.losses++
      })
      const r = saveManager.get().rating
      return { before, after, delta, wins: r.wins, losses: r.losses }
    },
    leaderboard: async (limit = 10): Promise<PlayerIdentity[]> => {
      const me = this.identity
      // Offline: synthesize a rating ladder around the player from the AI roster.
      const ai = allDrivers().map((d) => ({ id: d.id, name: d.name, rating: Math.round(900 + d.skill * 1100), avatarColor: d.color }))
      return [...ai, me].sort((a, b) => b.rating - a.rating).slice(0, limit)
    },
  }

  friends = {
    list: async (): Promise<Friend[]> => {
      const raw = localStorage.getItem(`apex-overdrive:${FRIENDS_KEY}`)
      return raw ? (JSON.parse(raw) as Friend[]) : []
    },
    add: async (name: string): Promise<Friend> => {
      const f: Friend = { id: randomCode(10), name, rating: 1200, avatarColor: `hsl(${Math.random() * 360},70%,55%)`, status: 'offline', lastSeen: Date.now() }
      const list = await this.friends.list()
      list.push(f)
      localStorage.setItem(`apex-overdrive:${FRIENDS_KEY}`, JSON.stringify(list))
      return f
    },
    remove: async (id: string): Promise<void> => {
      const list = (await this.friends.list()).filter((f) => f.id !== id)
      localStorage.setItem(`apex-overdrive:${FRIENDS_KEY}`, JSON.stringify(list))
    },
    invite: async (): Promise<boolean> => false,
  }

  voice = {
    state: (): VoiceState => this.voiceState,
    join: async (lobbyCode: string): Promise<VoiceState> => {
      const available = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
      this.voiceState = { ...this.voiceState, available, connected: false, participants: [lobbyCode] }
      return this.voiceState
    },
    leave: async (): Promise<void> => {
      this.voiceState = { ...this.voiceState, connected: false, participants: [] }
    },
    setMuted: (muted: boolean): void => {
      this.voiceState = { ...this.voiceState, muted }
    },
  }

  ghosts = {
    save: async (ghost: GhostLap): Promise<void> => {
      saveManager.update((p) => {
        const existing = p.ghosts[ghost.trackId]
        if (!existing || ghost.lapTime < existing.lapTime) {
          p.ghosts[ghost.trackId] = { carId: ghost.carId, lapTime: ghost.lapTime, sampleRate: ghost.sampleRate, samples: ghost.samples }
        }
      })
    },
    best: async (trackId: string): Promise<GhostLap | null> => {
      const g = saveManager.get().ghosts[trackId]
      if (!g) return null
      return { id: `ghost-${trackId}`, trackId, carId: g.carId, playerName: saveManager.get().playerName, lapTime: g.lapTime, sampleRate: g.sampleRate, samples: g.samples }
    },
    list: async (trackId: string): Promise<GhostLap[]> => {
      const g = await this.ghosts.best(trackId)
      return g ? [g] : []
    },
  }
}
