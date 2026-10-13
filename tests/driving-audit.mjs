import assert from 'node:assert/strict'
import { launchBrowser, SERVER } from './support/browser.mjs'

const browser = await launchBrowser()
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 960, height: 540 })
  await page.goto(SERVER)
  await page.waitForFunction(() => window.__apex?.mode === 'showcase', { timeout: 60000 })
  const tracks = process.argv.length > 2 ? process.argv.slice(2) : await page.evaluate(async () => (await import('/src/game/tracks/TrackCatalog.ts')).TRACK_CATALOG.map(track => track.id))
  const results = []
  for (const trackId of tracks) {
    await page.evaluate(async (trackId) => {
      const e = window.__apex
      e.running = false
      cancelAnimationFrame(e.rafId)
      await e.startRace({ mode: 'freeroam', trackId, carId: 'mercedes-w13', laps: 1, aiCount: 0, aiMix: 'pro', difficulty: 'pro', weather: 'clear', hour: 12, dynamicWeather: false, timeRate: 0, ghost: false, seed: 1 })
    }, trackId)
    const result = await page.evaluate(async () => {
      const { AIDriver } = await import('/src/game/ai/AIDriver.ts')
      const { generateField } = await import('/src/game/ai/DriverProfiles.ts')
      const e = window.__apex, c = e.player.controller, track = e.track
      c.damageEnabled = false
      c.assists = { abs: true, tcs: true, esc: true, autoTransmission: true }
      c.setHold('free')
      const ai = new AIDriver(c, e.racingLine, { ...generateField(1, 'pro', 1)[0], consistency: 1 }, track.spline.nearestIndex(c.position))
      const ctx = { traffic: [], playerProgress: 0, trackLength: track.spline.length, raceActive: true, wetness: 0, snow: 0, difficultyScale: 0.85, catchUp: 0, closed: track.def.closed, raceTime: 0 }
      let minUp = 1, peakSpeed = 0, distance = 0, flips = 0, respawns = 0, previous = ai.progress
      let firstProblem = null
      const duration = Math.max(100, track.def.bestLapReference * 2.2)
      for (let frame = 0; frame < duration * 60; frame++) {
        ctx.raceTime += 1 / 60
        track.hazards.update(1 / 60)
        const input = ai.update(1 / 60, ctx)
        e.physics.update(1 / 60, dt => c.step(dt, input))
        minUp = Math.min(minUp, c.up.y)
        peakSpeed = Math.max(peakSpeed, c.telemetry.speedKmh)
        let delta = ai.progress - previous
        if (delta < -ctx.trackLength / 2) delta += ctx.trackLength
        if (delta > ctx.trackLength / 2) delta -= ctx.trackLength
        // Reverse/recovery must not inflate coverage and masquerade as a lap.
        distance += delta
        previous = ai.progress
        if (c.up.y < 0.2) { flips++; firstProblem ??= { at: ai.progress, position: c.position.toArray(), speed: c.telemetry.speedKmh } }
        if (c.needsRespawn) {
          respawns++
          firstProblem ??= { at: ai.progress, position: c.position.toArray(), speed: c.telemetry.speedKmh, lateral: ai.lateral, intent: ai.intent, wheels: c.telemetry.wheelsOnGround, roadY: track.spline.atDistance(ai.progress).position.y }
          break
        }
        if (distance > ctx.trackLength * (ctx.closed ? 1.1 : 0.98)) break
      }
      return { track: track.def.id, minUp, peakSpeed, distance, lap: ctx.trackLength, flips, respawns, firstProblem }
    })
    results.push(result)
    console.log(JSON.stringify(result))
  }
  for (const result of results) {
    assert.equal(result.flips, 0, `${result.track}: formula car flipped`)
    assert.equal(result.respawns, 0, `${result.track}: car needed recovery`)
    assert.ok(result.distance > result.lap * 0.95, `${result.track}: failed to drive a lap (${result.distance.toFixed(0)} / ${result.lap.toFixed(0)} m)`)
  }
} finally { await browser.close() }
