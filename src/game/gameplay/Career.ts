/**
 * Story mode: six chapters of scripted events. Each event is a `RaceConfig`
 * template with narrative framing, star thresholds and rewards. Chapters
 * unlock by accumulated stars.
 */

import type { GameModeId, RaceConfig } from './GameModes'
import type { FieldMix } from '../ai/DriverProfiles'
import type { WeatherKind } from '../tracks/TrackCatalog'
import { saveManager } from '../persistence/SaveManager'
import { bus } from '../core/EventBus'

export interface CareerEvent {
  id: string
  title: string
  intro: string
  mode: GameModeId
  trackId: string
  laps: number
  aiCount: number
  aiMix: FieldMix
  weather: WeatherKind | 'random'
  hour: number | 'default'
  rewardCredits: number
  rewardCar?: string
  requiredClass?: string[]
  rivalId?: string
}

export interface CareerChapter {
  index: number
  title: string
  blurb: string
  starsToUnlock: number
  events: CareerEvent[]
}

export const CAREER: CareerChapter[] = [
  {
    index: 0,
    title: 'Chapter 1 — Club Nights',
    blurb: 'A borrowed roadster, a coastal club series and a lot to prove. Nobody here knows your name yet.',
    starsToUnlock: 0,
    events: [
      { id: 'c1-e1', title: 'First Light', intro: 'The Isla Verde club runs a Sunday sprint. Three laps. Show them what the Cobra can do.', mode: 'quick', trackId: 'island-causeway', laps: 2, aiCount: 5, aiMix: 'rookie', weather: 'clear', hour: 8, rewardCredits: 6000 },
      { id: 'c1-e2', title: 'Lakeside Hot Lap', intro: 'Set a lap under 1:40 at Lago Sereno to qualify for the club championship.', mode: 'timetrial', trackId: 'lakeside-circuit', laps: 3, aiCount: 0, aiMix: 'rookie', weather: 'clear', hour: 10, rewardCredits: 5000 },
      { id: 'c1-e3', title: 'Forest Dust-Up', intro: 'Ardenne in the morning fog. Six rookies, one podium. Watch the logging crossing.', mode: 'quick', trackId: 'woodland-raceway', laps: 3, aiCount: 7, aiMix: 'rookie', weather: 'fog', hour: 7, rewardCredits: 8000 },
      { id: 'c1-e4', title: 'Last One Standing', intro: 'Elimination race around the causeway. Every twenty seconds the tail car goes home.', mode: 'elimination', trackId: 'island-causeway', laps: 20, aiCount: 9, aiMix: 'amateur', weather: 'cloudy', hour: 16, rewardCredits: 12000, rewardCar: 'mercedes-190e' },
    ],
  },
  {
    index: 1,
    title: 'Chapter 2 — Street Legal',
    blurb: 'The city league notices. Metro nights, drift meets and a rival called Rafael Costa who never lifts.',
    starsToUnlock: 6,
    events: [
      { id: 'c2-e1', title: 'Metro Rush Hour', intro: 'Harbor City at dusk. Ninety-degree corners, level crossing, thirteen cars.', mode: 'quick', trackId: 'metro-loop', laps: 3, aiCount: 11, aiMix: 'amateur', weather: 'clear', hour: 18, rewardCredits: 12000, rivalId: 'rafael-costa' },
      { id: 'c2-e2', title: 'Slide Night', intro: 'The drift crew wants 25,000 points before they take you seriously. Any car, any angle.', mode: 'drift', trackId: 'lakeside-circuit', laps: 2, aiCount: 0, aiMix: 'amateur', weather: 'clear', hour: 20, rewardCredits: 10000, rewardCar: 'dodge-charger' },
      { id: 'c2-e3', title: 'Wet Docks', intro: 'Rotterdam in the rain. The crane swings on a twelve-second cycle; learn it.', mode: 'quick', trackId: 'shipyard-district', laps: 3, aiCount: 9, aiMix: 'amateur', weather: 'rain', hour: 19, rewardCredits: 14000 },
      { id: 'c2-e4', title: 'Costa Cup', intro: 'A four-round season cup. Costa is quick everywhere. Beat him on points.', mode: 'championship', trackId: 'metro-loop', laps: 3, aiCount: 11, aiMix: 'amateur', weather: 'random', hour: 'default', rewardCredits: 25000, rivalId: 'rafael-costa', rewardCar: 'mercedes-clk-dtm' },
    ],
  },
  {
    index: 2,
    title: 'Chapter 3 — Off the Map',
    blurb: 'Sponsors call. The Badlands sprint and the Alpine hairpins separate drivers from passengers.',
    starsToUnlock: 14,
    events: [
      { id: 'c3-e1', title: 'Badlands Dash', intro: 'Point-to-point through the canyon. Mine carts, rockfall, gravel. One shot.', mode: 'sprint', trackId: 'badlands-run', laps: 1, aiCount: 9, aiMix: 'pro', weather: 'clear', hour: 18, rewardCredits: 18000 },
      { id: 'c3-e2', title: 'Rally Roots', intro: 'Gravel shortcuts only pay off in the right car. Take the Torrent through Ardenne.', mode: 'quick', trackId: 'woodland-raceway', laps: 3, aiCount: 9, aiMix: 'pro', weather: 'overcast', hour: 9, rewardCredits: 16000, requiredClass: ['rally'] },
      { id: 'c3-e3', title: 'Stelvio Knockout', intro: 'Three heats up the mountain. Top half advances. The final is two laps of hairpins.', mode: 'knockout', trackId: 'alpine-ridge', laps: 2, aiCount: 11, aiMix: 'pro', weather: 'cloudy', hour: 9, rewardCredits: 22000 },
      { id: 'c3-e4', title: 'Alpine Endurance', intro: 'Eight laps. Fuel and damage matter; the pit lane is on the right after the viaduct.', mode: 'endurance', trackId: 'alpine-ridge', laps: 8, aiCount: 11, aiMix: 'pro', weather: 'random', hour: 15, rewardCredits: 30000, rewardCar: 'lamborghini-huracan-gt3' },
    ],
  },
  {
    index: 3,
    title: 'Chapter 4 — Cold Front',
    blurb: 'Iceland in winter and a rival who does not make mistakes: Marcus Hale.',
    starsToUnlock: 24,
    events: [
      { id: 'c4-e1', title: 'Glacier Baptism', intro: 'Winter tyres or nothing. Ice patches migrate; the tunnel is your only dry line.', mode: 'quick', trackId: 'glacier-road', laps: 2, aiCount: 9, aiMix: 'pro', weather: 'snow', hour: 11, rewardCredits: 20000 },
      { id: 'c4-e2', title: 'Whiteout Elimination', intro: 'Blizzard. Elimination. Visibility is a rumour.', mode: 'elimination', trackId: 'glacier-road', laps: 20, aiCount: 11, aiMix: 'pro', weather: 'blizzard', hour: 14, rewardCredits: 24000 },
      { id: 'c4-e3', title: 'Hale Storm', intro: 'Hale sets the bar at Woodland in a storm. Beat his lap in the time trial.', mode: 'timetrial', trackId: 'woodland-raceway', laps: 4, aiCount: 0, aiMix: 'elite', weather: 'storm', hour: 16, rewardCredits: 18000, rivalId: 'marcus-hale' },
      { id: 'c4-e4', title: 'Frozen Cup', intro: 'Four rounds across the north. Hale is in every one of them.', mode: 'championship', trackId: 'glacier-road', laps: 2, aiCount: 11, aiMix: 'elite', weather: 'random', hour: 'default', rewardCredits: 40000, rivalId: 'marcus-hale', rewardCar: 'jaguar-i-type' },
    ],
  },
  {
    index: 4,
    title: 'Chapter 5 — Neon Nights',
    blurb: 'Shinjuku. Rain-slick, neon-lit, and Aiko Tanaka drifting the spiral like it owes her money.',
    starsToUnlock: 36,
    events: [
      { id: 'c5-e1', title: 'Boulevard Debut', intro: 'Thirteen cars under the signs. The fountain floods the chicane every ten seconds.', mode: 'quick', trackId: 'neon-boulevard', laps: 3, aiCount: 13, aiMix: 'elite', weather: 'rain', hour: 22, rewardCredits: 28000 },
      { id: 'c5-e2', title: 'Tanaka Tandem', intro: 'Drift the boulevard. 60,000 points earns her respect.', mode: 'drift', trackId: 'neon-boulevard', laps: 3, aiCount: 2, aiMix: 'elite', weather: 'cloudy', hour: 23, rewardCredits: 25000, rivalId: 'aiko-tanaka' },
      { id: 'c5-e3', title: 'Midnight Knockout', intro: 'Knockout heats on the Metro Loop after dark.', mode: 'knockout', trackId: 'metro-loop', laps: 2, aiCount: 13, aiMix: 'elite', weather: 'clear', hour: 0, rewardCredits: 32000 },
      { id: 'c5-e4', title: 'City Endurance', intro: 'Twelve laps of Shipyard. Manage the crane, the fuel and thirteen elite rivals.', mode: 'endurance', trackId: 'shipyard-district', laps: 12, aiCount: 13, aiMix: 'elite', weather: 'random', hour: 20, rewardCredits: 45000, rewardCar: 'lamborghini-revuelto' },
    ],
  },
  {
    index: 5,
    title: 'Chapter 6 — Apex League',
    blurb: 'The final tier. Kai Moreno and Inés Varga have owned this league for years.',
    starsToUnlock: 50,
    events: [
      { id: 'c6-e1', title: 'Pro-Am Qualifier', intro: 'Track special, Lakeside, twelve legends. Podium or go home.', mode: 'quick', trackId: 'lakeside-circuit', laps: 4, aiCount: 13, aiMix: 'legend', weather: 'clear', hour: 12, rewardCredits: 35000, requiredClass: ['track', 'supercar', 'prototype', 'gt'] },
      { id: 'c6-e2', title: 'Alpine Assault', intro: 'Two laps of Stelvio against Moreno. He does not brake early.', mode: 'quick', trackId: 'alpine-ridge', laps: 2, aiCount: 13, aiMix: 'legend', weather: 'random', hour: 'default', rewardCredits: 40000, rivalId: 'kai-moreno' },
      { id: 'c6-e3', title: 'Twenty-Four Minutes', intro: 'Endurance at the causeway. Varga\'s prototype finds grip where there is none.', mode: 'endurance', trackId: 'island-causeway', laps: 14, aiCount: 13, aiMix: 'legend', weather: 'random', hour: 17, rewardCredits: 60000, rivalId: 'ines-varga', rewardCar: 'mclaren-f1-gtr' },
      { id: 'c6-e4', title: 'Apex Grand Final', intro: 'Four rounds. Every legend. The league title.', mode: 'championship', trackId: 'neon-boulevard', laps: 3, aiCount: 13, aiMix: 'legend', weather: 'random', hour: 'default', rewardCredits: 120000, rewardCar: 'mclaren-f1-gtr-longtail' },
    ],
  },
]

export const SERIES_TRACKS: Record<string, string[]> = {
  'c2-e4': ['metro-loop', 'island-causeway', 'shipyard-district', 'lakeside-circuit'],
  'c4-e4': ['glacier-road', 'alpine-ridge', 'woodland-raceway', 'glacier-road'],
  'c6-e4': ['neon-boulevard', 'alpine-ridge', 'badlands-run', 'metro-loop'],
}

export function careerStars(): number {
  const p = saveManager.get()
  return Object.values(p.career.eventStars).reduce((a, b) => a + b, 0)
}

export function chapterUnlocked(chapter: CareerChapter): boolean {
  return careerStars() >= chapter.starsToUnlock
}

export function eventUnlocked(chapter: CareerChapter, index: number): boolean {
  if (!chapterUnlocked(chapter)) return false
  if (index === 0) return true
  const prev = chapter.events[index - 1]
  return (saveManager.get().career.eventStars[prev.id] ?? 0) >= 1
}

export function starsForResult(mode: GameModeId, position: number, driftScore: number, bestLap: number, referenceLap: number): number {
  if (mode === 'drift') return driftScore >= 60000 ? 3 : driftScore >= 25000 ? 2 : driftScore >= 8000 ? 1 : 0
  if (mode === 'timetrial') return bestLap <= referenceLap * 1.02 ? 3 : bestLap <= referenceLap * 1.1 ? 2 : bestLap < referenceLap * 1.3 ? 1 : 0
  if (mode === 'freeroam') return 0
  return position === 1 ? 3 : position <= 3 ? 2 : position <= 6 ? 1 : 0
}

export function recordCareerResult(eventId: string, stars: number): { newStars: number; rewardCredits: number; rewardCar?: string } {
  const ev = CAREER.flatMap((c) => c.events).find((e) => e.id === eventId)
  if (!ev) return { newStars: 0, rewardCredits: 0 }
  let newStars = 0
  let rewardCredits = 0
  let rewardCar: string | undefined
  saveManager.update((p) => {
    const prev = p.career.eventStars[eventId] ?? 0
    if (stars > prev) {
      p.career.eventStars[eventId] = stars
      newStars = stars - prev
    }
    if (stars >= 1 && !p.career.completedEvents.includes(eventId)) {
      p.career.completedEvents.push(eventId)
      rewardCredits = ev.rewardCredits
      p.credits += rewardCredits
      if (ev.rewardCar && !p.ownedCars.includes(ev.rewardCar)) {
        p.ownedCars.push(ev.rewardCar)
        rewardCar = ev.rewardCar
      }
    }
    const chapterIdx = CAREER.findIndex((c) => c.events.some((e) => e.id === eventId))
    p.career.chapter = Math.max(p.career.chapter, chapterIdx)
  })
  if (rewardCredits) bus.emit('progress:credits', { delta: rewardCredits, total: saveManager.get().credits, reason: 'career' })
  if (rewardCar) bus.emit('progress:unlock', { kind: 'car', id: rewardCar, title: `Career reward: new car in your garage` })
  return { newStars, rewardCredits, rewardCar }
}

export function careerEventToConfig(ev: CareerEvent, carId: string): Partial<RaceConfig> {
  return {
    mode: ev.mode,
    trackId: ev.trackId,
    carId,
    laps: ev.laps,
    aiCount: ev.aiCount,
    aiMix: ev.aiMix,
    weather: ev.weather,
    hour: ev.hour,
    eventId: ev.id,
    dynamicWeather: ev.weather === 'random',
  }
}
