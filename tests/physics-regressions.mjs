import assert from 'node:assert/strict'
import { launchBrowser, harness } from './support/browser.mjs'

// Regression: formula cars flipped on a completely flat, empty triangulated road.
// The original 60 Hz W13 launched 24 m upwards with 598 kN at one suspension corner.
const browser = await launchBrowser()
try {
  const page = await harness(browser)
  const results = await page.evaluate(async () => {
    const { registerInstalledContent } = await import('/src/game/content/installed.ts')
    registerInstalledContent()
    const { PhysicsWorld } = await import('/src/game/physics/PhysicsWorld.ts')
    const { VehicleController } = await import('/src/game/physics/VehicleController.ts')
    const { VEHICLE_CATALOG } = await import('/src/game/vehicles/VehicleCatalog.ts')
    const T = await import('/node_modules/three/build/three.module.js')
    const output = []
    for (const spec of VEHICLE_CATALOG) {
      const physics = await PhysicsWorld.create()
      const vertices = [], indices = []
      // Lots of triangle seams under low floors; long enough to reach top speed.
      for (let z = -20; z <= 5000; z += 2) {
        const n = vertices.length / 3
        vertices.push(-200, 0, z, 200, 0, z)
        if (n) indices.push(n - 2, n, n - 1, n - 1, n, n + 1)
      }
      physics.addStaticTrimesh(new Float32Array(vertices), new Uint32Array(indices), { surface: 'asphalt' })
      physics.world.updateSceneQueries()
      const car = new VehicleController(physics, spec, 0, new T.Vector3(0, spec.comHeight + 0.1, 0), new T.Quaternion())
      let maxVertical = 0, minUp = 1, maxHeight = 0, speed = 0
      const drive = { steer: 0, throttle: 0, brake: 0, handbrake: false, boost: false }
      for (let i = 0; i < 2400; i++) {
        drive.throttle = i > 120 ? 1 : 0
        physics.update(1 / 60, dt => car.step(dt, drive))
        if (i > 120) {
          maxVertical = Math.max(maxVertical, Math.abs(car.velocity.y))
          minUp = Math.min(minUp, car.up.y)
          maxHeight = Math.max(maxHeight, car.position.y)
          speed = Math.max(speed, car.telemetry.speedKmh)
        }
      }
      // Manual reverse must use throttle, not switch itself back to first gear.
      car.teleport(new T.Vector3(0, spec.comHeight, 0), new T.Quaternion())
      car.assists.autoTransmission = false
      car.gear = -1
      drive.throttle = 0.5
      for (let i = 0; i < 180; i++) physics.update(1 / 60, dt => car.step(dt, drive))
      output.push({ id: spec.id, maxVertical, minUp, maxHeight, speed, com: spec.comHeight, reverseGear: car.gear, reverseSpeed: car.velocity.z })
      physics.dispose()
    }
    return output
  })
  for (const r of results) {
    assert.ok(r.minUp > 0.98, `${r.id}: tipped over (${r.minUp})`)
    assert.ok(r.maxVertical < 0.5, `${r.id}: vertical instability (${r.maxVertical} m/s)`)
    assert.ok(r.maxHeight < r.com + 0.1, `${r.id}: launched off flat road`)
    assert.ok(r.speed > 100, `${r.id}: failed to accelerate`)
    assert.equal(r.reverseGear, -1, `${r.id}: manual reverse disengaged`)
    assert.ok(r.reverseSpeed < -1, `${r.id}: cannot drive backwards in manual`)
    console.log(`PASS ${r.id}: ${r.speed.toFixed(0)} km/h, vertical ${r.maxVertical.toFixed(3)} m/s, upright ${r.minUp.toFixed(4)}, manual reverse`)
  }
} finally { await browser.close() }
