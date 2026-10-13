/** Deterministic driver decisions and controller-compatible recovery. */
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
try {
  const { AIDriver } = await server.ssrLoadModule('/src/game/ai/AIDriver.ts')
  const { RacingLine } = await server.ssrLoadModule('/src/game/ai/RacingLine.ts')
  const { TrackSpline } = await server.ssrLoadModule('/src/game/tracks/Spline.ts')
  const { VEHICLE_CATALOG } = await server.ssrLoadModule('/src/game/vehicles/VehicleCatalog.ts')
  const { generateField } = await server.ssrLoadModule('/src/game/ai/DriverProfiles.ts')
  const T = await import('three')
  const spline = new TrackSpline([new T.Vector3(0, 0, 0), new T.Vector3(0, 0, 400), new T.Vector3(400, 0, 400), new T.Vector3(400, 0, 0)], true)
  const line = new RacingLine(spline, 8)
  const make = consistency => {
    const sample = spline.samples[0]
    const vehicle = { id: 0, spec: VEHICLE_CATALOG.find(v => v.id === 'mercedes-w13'), position: sample.position.clone(), forward: sample.tangent.clone(), velocity: new T.Vector3(), telemetry: { speed: 0, driftAngle: 0, onLooseSurface: false }, gripScale: 1, powerScale: 1, getDamage: () => 0, getNitroFraction: () => 1, needsRespawn: false }
    const driver = new AIDriver(vehicle, line, { ...generateField(1, 'pro', 1)[0], consistency }, 0)
    const ctx = { traffic: [], playerProgress: 0, trackLength: spline.length, raceActive: true, wetness: 0, snow: 0, difficultyScale: 0.85, catchUp: 0, closed: true, raceTime: 0 }
    return { vehicle, driver, ctx }
  }
  const { vehicle, driver, ctx } = make(1)
  let reverseFrames = 0
  for (let frame = 0; frame < 480; frame++) {
    ctx.raceTime += 1 / 60
    const input = driver.update(1 / 60, ctx)
    if (input.brake > 0.4 && input.throttle === 0) {
      reverseFrames++
      // The vehicle is facing the correct direction but its nose is pinned.
      // Reverse must exceed the gearbox threshold and persist long enough to
      // engage reverse and back the chassis away before trying forward again.
      if (reverseFrames < 60) assert.equal(input.handbrake, false)
      vehicle.telemetry.speed = reverseFrames > 30 ? -3 : 0
    } else if (reverseFrames) break
  }
  assert.ok(reverseFrames >= 100, `Only ${reverseFrames} reverse frames before rejoining`)
  assert.equal(vehicle.needsRespawn, false)
  console.log('PASS a correctly facing, stuck car holds reverse beyond engagement dwell')

  const decisions = consistency => {
    const { vehicle, driver, ctx } = make(consistency)
    const output = []
    for (let frame = 0; frame < 10800; frame++) {
      const sample = spline.atDistance(frame * 0.5)
      vehicle.position.copy(sample.position); vehicle.forward.copy(sample.tangent)
      vehicle.telemetry.speed = 30
      ctx.raceTime += 1 / 60
      const input = driver.update(1 / 60, ctx)
      if (consistency === 1) assert.notEqual(driver.intent, 'mistake', 'Perfect-consistency driver made a random braking error')
      if (frame % 30 === 0) output.push([input.steer, input.throttle, input.brake, input.boost, driver.intent])
    }
    return output
  }
  decisions(1)
  console.log('PASS perfect consistency suppresses all random driving mistakes')
  assert.deepEqual(decisions(0.6), decisions(0.6))
  console.log('PASS a driver and grid position reproduce the same decisions in simulation time')
} finally { await server.close() }
