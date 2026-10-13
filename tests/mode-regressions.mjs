import assert from 'node:assert/strict'
import { createServer } from 'vite'
import * as THREE from 'three'
import { launchBrowser, SERVER } from './support/browser.mjs'

// Test race rules independently of driving skill, including a skipped checkpoint.
const modules = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
try {
  const { RaceManager } = await modules.ssrLoadModule('/src/game/gameplay/RaceManager.ts')
  const { TrackSpline } = await modules.ssrLoadModule('/src/game/tracks/Spline.ts')
  const spline = new TrackSpline([0, 100, 200, 300].map(z => new THREE.Vector3(0, 0, z)), false)
  const track = { def: { closed: false }, spline, sectorDistances: [], checkpoints: [0, 100, 200, 290].map(distance => ({ distance, required: true, halfWidth: 8 })) }
  const make = () => {
    const race = new RaceManager(track, { mode: 'sprint', laps: 1 })
    const racer = race.addRacer(0, 'Player', 'mercedes-w13', true, { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() })
    race.startCountdown(3)
    const observe = (z, x = 0, dt = 1 / 60) => race.update(dt, [{ id: 0, position: new THREE.Vector3(x, 0, z), forward: new THREE.Vector3(0, 0, 1), speedKmh: 36, damage: 0, driftScore: 0 }])
    return { race, racer, observe }
  }
  const grid = make()
  for (let z = 10; z <= 110; z += 10) grid.observe(z)
  assert.equal(grid.racer.finished, false, 'the sprint start marker is not a finish line')
  assert.equal(grid.racer.checkpointsHit[1], false, 'countdown movement cannot earn checkpoints')
  for (const skip of [false, true]) {
    const { racer, observe } = make()
    observe(10, 0, 3)
    for (let z = 20; z <= 295; z += 5) observe(z, skip && z >= 190 && z <= 210 ? 30 : 0)
    assert.equal(racer.finished, !skip, 'sprint finish requires every mandatory checkpoint')
    if (!skip) assert.equal(racer.lapTimes.length, 1)
  }
  console.log('PASS sprint start/countdown protection and required-checkpoint finish validation')
} finally { await modules.close() }

const browser = await launchBrowser()
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(SERVER)
  await page.waitForFunction(() => window.__apex?.mode === 'showcase', { timeout: 60000 })
  for (const mode of process.argv.length > 2 ? process.argv.slice(2) : ['career', 'quick', 'timetrial', 'championship', 'elimination', 'drift', 'sprint', 'endurance', 'knockout', 'freeroam']) {
    const result = await page.evaluate(async mode => {
      const e = window.__apex
      e.running = false; cancelAnimationFrame(e.rafId)
      const config = { mode, trackId: mode === 'sprint' ? 'badlands-run' : 'lakeside-circuit', carId: 'mercedes-w13', laps: 1, aiCount: ['quick', 'sprint', 'timetrial', 'freeroam'].includes(mode) ? 0 : 1, aiMix: 'rookie', difficulty: 'rookie', weather: 'clear', hour: 12, dynamicWeather: false, timeRate: 0, ghost: false, seed: 7 }
      if (mode === 'championship' || mode === 'knockout') await e.startSeries(config, mode)
      else await e.startRace(config)
      const started = e.mode === 'race' && e.race?.config.mode === mode
      if (!started) return { started }
      // Exercise the real countdown, mode state and results pipeline. Lap-driving
      // geometry is separately covered by driving-audit, not simulated by teleporting.
      for (let i = 0; i < 300; i++) e.updateRace(1 / 60)
      const active = e.race.active
      const diagnostics = { phase: e.race.phase, countdown: e.race.countdown, racers: [...e.race.racers.values()].map(r => ({ progress: r.progress, finished: r.finished, next: r.nextCheckpoint, lap: r.lap })), cps: e.track.checkpoints.map(cp => cp.distance) }
      let finishedNaturally = null
      if (mode === 'quick' || mode === 'sprint') {
        e.setAutopilot(true)
        e.player.ai.profile.consistency = 1
        for (let frame = 0; frame < 36000 && e.race.phase !== 'finished'; frame++) {
          e.elapsed += 1 / 60
          e.updateRace(1 / 60)
        }
        finishedNaturally = e.race.player.finished && e.race.player.lapTimes.length === 1 && e.race.player.checkpointsHit.every((hit, i) => !e.track.checkpoints[i].required || hit || mode === 'quick')
        e.setAutopilot(false)
      } else e.finishRaceEarly()
      const { gameStore } = await import('/src/game/state/GameStore.ts')
      const results = gameStore.get().results
      const classified = results?.entries.length === e.vehicles.length
      await e.quitToMenu()
      return { started, active, diagnostics, finishedNaturally, classified, seriesCleared: e.series === null, colliders: e.physics.world.colliders.len() }
    }, mode)
    assert.equal(result.started, true, `${mode}: session failed to start`)
    if (!result.active) console.log(JSON.stringify(result))
    assert.equal(result.active, true, `${mode}: countdown did not activate`)
    if (mode === 'quick' || mode === 'sprint') assert.equal(result.finishedNaturally, true, `${mode}: real lap/checkpoints did not finish the race`)
    assert.equal(result.classified, true, `${mode}: results lost racers`)
    assert.equal(result.seriesCleared, true, `${mode}: canceled series leaked into next race`)
    assert.equal(result.colliders, 0, `${mode}: leaked colliders`)
    console.log(`PASS ${mode}: start, countdown, classification, exit and disposal`)
  }
  for (const kind of ['championship', 'knockout']) {
    const result = await page.evaluate(async kind => {
      const e = window.__apex
      await e.startSeries({ mode: kind, trackId: 'lakeside-circuit', carId: 'mercedes-w13', laps: 1, aiCount: 5, aiMix: 'rookie', difficulty: 'rookie', weather: 'clear', hour: 12, dynamicWeather: false, timeRate: 0, ghost: false, seed: 7 }, kind)
      const { TRACK_BY_ID } = await import('/src/game/tracks/TrackCatalog.ts')
      const closedRounds = e.series.rounds.every(id => TRACK_BY_ID[id].closed)
      // Exercise series bookkeeping on one real circuit; the track audit drives all layouts.
      e.series.rounds.fill('lakeside-circuit')
      const roster = e.vehicles.map(v => v.name), counts = []
      let consistent = true
      for (let round = 0; round < (kind === 'championship' ? 4 : 3); round++) {
        counts.push(e.vehicles.length)
        consistent &&= e.vehicles.every(v => roster.includes(v.name) && !e.series.eliminated.includes(v.name))
        for (let frame = 0; frame < 300; frame++) e.updateRace(1 / 60)
        // A deterministic classification isolates progression from driver speed.
        // The real finish-line pipeline is covered above by quick and sprint laps.
        const ordered = [...e.race.racers.values()].sort((a, b) => Number(b.isPlayer) - Number(a.isPlayer) || a.vehicleId - b.vehicleId)
        ordered.forEach((r, i) => { r.totalProgress = 1000 - i * 10 })
        e.race.standingsDirty = true
        e.finishRaceEarly()
        if (!e.series.finished) await e.continueSeries()
      }
      const finished = e.series.finished
      const standings = e.seriesStandings()
      const playerWins = standings[0].name === e.player.name
      await e.quitToMenu()
      return { counts, consistent, finished, closedRounds, playerWins, cleared: e.series === null && e.seriesDrivers.length === 0 }
    }, kind)
    assert.deepEqual(result.counts, kind === 'championship' ? [6, 6, 6, 6] : [6, 3, 2])
    for (const key of ['consistent', 'finished', 'closedRounds', 'playerWins', 'cleared']) assert.equal(result[key], true, `${kind}: ${key}`)
    console.log(`PASS ${kind}: every round, persistent opponents, survivor counts, final standings and cleanup`)
  }
  assert.deepEqual(errors, [])
} finally { await browser.close() }
