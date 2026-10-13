import assert from 'node:assert/strict'
import { launchBrowser, harness } from './support/browser.mjs'

const browser = await launchBrowser()
try {
  const page = await harness(browser)
  const results = await page.evaluate(async () => {
    const T = await import('/node_modules/three/build/three.module.js')
    const { PhysicsWorld } = await import('/src/game/physics/PhysicsWorld.ts')
    const { TrackSpline } = await import('/src/game/tracks/Spline.ts')
    const { HazardSystem } = await import('/src/game/tracks/Hazards.ts')
    const results = []
    for (const kind of ['ice', 'fountain']) {
      const physics = await PhysicsWorld.create()
      const R = physics.RAPIER
      const spline = new TrackSpline([[0, 0, 0], [10, 4, 40], [30, 10, 80], [25, 18, 120], [0, 22, 160]].map(p => new T.Vector3(...p)), false, 2)
      const hazards = new HazardSystem(physics, {})
      hazards.add({ type: 'hazard', kind, at: 0.5, period: 20, span: 60 }, spline, 6, () => 0)
      physics.world.updateSceneQueries()
      const centre = spline.atT(0.5).distance
      let samples = 0, maxHeightError = 0, missing = 0
      for (let along = -28; along <= 28; along += 2) {
        const sample = spline.atDistance(centre + along)
        for (const lateral of [-3, 0, 3]) {
          const point = sample.position.clone().addScaledVector(sample.right, lateral)
          const hit = physics.world.castRayAndGetNormal(new R.Ray({ x: point.x, y: point.y + 2, z: point.z }, { x: 0, y: -1, z: 0 }), 4, true)
          samples++
          if (!hit) { missing++; continue }
          maxHeightError = Math.max(maxHeightError, Math.abs(2 - hit.timeOfImpact))
        }
      }
      hazards.update(15)
      physics.world.updateSceneQueries()
      let activeColliders = 0
      physics.world.colliders.forEach(collider => { if (collider.isEnabled()) activeColliders++ })
      results.push({ kind, samples, missing, maxHeightError, activeColliders })
      hazards.dispose()
      physics.dispose()
    }
    return results
  })
  for (const r of results) {
    assert.equal(r.missing, 0, `${r.kind}: patch must follow the curved road`)
    assert.ok(r.maxHeightError < 0.025, `${r.kind}: invisible suspension step (${r.maxHeightError} m)`)
    assert.equal(r.activeColliders, 0, `${r.kind}: inactive patch still affects tyres`)
    console.log(`PASS ${r.kind}: ${r.samples} inclined/curved road probes within ${(r.maxHeightError * 1000).toFixed(1)} mm; inactive surface disabled`)
  }
} finally { await browser.close() }
