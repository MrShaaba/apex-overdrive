/**
 * Network service contracts. The game only depends on these interfaces; the
 * shipped implementation (`LocalNetworkProvider`) is offline and deterministic,
 * but every method mirrors what a real backend (WebSocket + REST) would expose
 * so online features can be added without touching gameplay code.
 */

export type ConnectionStatus = 'offline' | 'connecting' | 'online' | 'error'

export interface PlayerIdentity {
  id: string
  name: string
  rating: number
  avatarColor: string
}

export interface MatchTicket {
  id: string
  mode: string
  trackId: string
  createdAt: number
  status: 'queued' | 'found' | 'cancelled' | 'timeout'
  estimatedWaitSec: number
}

export interface Lobby {
  code: string
  hostId: string
  mode: string
  trackId: string
  laps: number
  maxPlayers: number
  players: PlayerIdentity[]
  inviteOnly: boolean
  createdAt: number
}

export interface RatingResult {
  before: number
  after: number
  delta: number
  wins: number
  losses: number
}

export interface Friend extends PlayerIdentity {
  status: 'online' | 'offline' | 'racing'
  lastSeen: number
}

export interface VoiceState {
  available: boolean
  connected: boolean
  muted: boolean
  speaking: boolean
  participants: string[]
}

export interface GhostLap {
  id: string
  trackId: string
  carId: string
  playerName: string
  lapTime: number
  sampleRate: number
  samples: number[]
}

export interface MatchmakingService {
  enqueue(mode: string, trackId: string): Promise<MatchTicket>
  cancel(ticketId: string): Promise<void>
  poll(ticketId: string): Promise<MatchTicket | null>
}

export interface LobbyService {
  create(opts: { mode: string; trackId: string; laps: number; maxPlayers: number; inviteOnly: boolean }): Promise<Lobby>
  join(code: string): Promise<Lobby | null>
  leave(code: string): Promise<void>
  list(): Promise<Lobby[]>
}

export interface RatingService {
  get(): Promise<number>
  /** Report a finished race: field ratings + finishing position → new rating. */
  report(playerPosition: number, fieldSize: number, opponentRatings: number[]): Promise<RatingResult>
  leaderboard(limit?: number): Promise<PlayerIdentity[]>
}

export interface FriendsService {
  list(): Promise<Friend[]>
  add(name: string): Promise<Friend>
  remove(id: string): Promise<void>
  invite(friendId: string, lobbyCode: string): Promise<boolean>
}

export interface VoiceService {
  state(): VoiceState
  join(lobbyCode: string): Promise<VoiceState>
  leave(): Promise<void>
  setMuted(muted: boolean): void
}

export interface GhostService {
  save(ghost: GhostLap): Promise<void>
  best(trackId: string): Promise<GhostLap | null>
  list(trackId: string): Promise<GhostLap[]>
}

export interface NetworkProvider {
  readonly status: ConnectionStatus
  readonly identity: PlayerIdentity
  matchmaking: MatchmakingService
  lobbies: LobbyService
  ratings: RatingService
  friends: FriendsService
  voice: VoiceService
  ghosts: GhostService
  connect(): Promise<ConnectionStatus>
  disconnect(): Promise<void>
}
