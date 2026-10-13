/** Real exported geometry versus physical ground, including ground-classified
 * invisible ramps that the obstacle-only collider audit cannot detect. */
import assert from 'node:assert/strict'
import { launchBrowser, SERVER } from './support/browser.mjs'
const browser = await launchBrowser()
try {
  const page = await browser.newPage()
  await page.goto(SERVER)
  await page.waitForFunction(() => window.__apex?.mode === 'showcase', { timeout: 60000 })
  for (const trackId of ['indianapolis', 'suzuka', 'marina']) {
    await page.evaluate(async trackId => {
      const e = window.__apex
      e.running = false; cancelAnimationFrame(e.rafId)
      await e.startRace({ mode: 'freeroam', trackId, carId: 'mercedes-w13', laps: 1, aiCount: 0, aiMix: 'pro', difficulty: 'pro', weather: 'clear', hour: 12, dynamicWeather: false, timeRate: 0, ghost: false, seed: 1 })
    }, trackId)
    const result = await page.evaluate(async trackId => {
      const T = await import('/node_modules/three/build/three.module.js')
      const e = window.__apex, track = e.track, physics = e.physics, R = physics.RAPIER
      track.root.updateMatrixWorld(true)
      physics.world.updateSceneQueries()
      const points = []
      if (trackId === 'indianapolis') {
        // The banked visible patch was replaced by a synthetic 0.9m ridge.
        for (const [x, z] of [[565.923, -357.671], [565.997, -356.674], [566.07, -355.677]]) points.push(new T.Vector3(x, 9.65, z))
      } else if (trackId === 'suzuka') {
        // Lower road approaching the overpass: the wide grass catch sheet used
        // to interpolate upward into this road and launch the car.
        for (let distance = 2308; distance <= 2324; distance += 2) {
          const sample = track.spline.atDistance(distance)
          for (let lateral = -2; lateral <= 2; lateral++) points.push(sample.position.clone().addScaledVector(sample.right, lateral))
        }
      } else {
        // Painted apex geometry classified as scenery had no ground collider.
        points.push(new T.Vector3(-568, 45.22, -44), new T.Vector3(-568, 45.22, -45))
      }
      const ray = new T.Raycaster(), down = new T.Vector3(0, -1, 0), samples = []
      for (const point of points) {
        const top = point.y + 2
        ray.set(new T.Vector3(point.x, top, point.z), down); ray.far = 4
        const visual = ray.intersectObject(track.root, true).find(hit => hit.face && Math.abs(hit.face.normal.y) > 0.65)
        let ground = -Infinity
        physics.world.intersectionsWithRay(new R.Ray({ x: point.x, y: top, z: point.z }, down), 4, true, hit => {
          const meta = physics.getMeta(hit.collider.handle)
          if (meta?.surface && !meta.wall && !hit.collider.isSensor()) ground = Math.max(ground, top - hit.timeOfImpact)
          return true
        })
        samples.push({ x: point.x, z: point.z, visibleY: visual?.point.y ?? null, groundY: Number.isFinite(ground) ? ground : null, mesh: visual?.object.name ?? null, delta: visual && Number.isFinite(ground) ? ground - visual.point.y : null })
      }
      return { trackId, samples }
    }, trackId)
    for (const sample of result.samples) {
      assert.notEqual(sample.visibleY, null, `${trackId}: visible road missing at ${JSON.stringify(sample)}`)
      assert.notEqual(sample.groundY, null, `${trackId}: physical road missing at ${JSON.stringify(sample)}`)
      assert.ok(sample.delta <= 0.08, `${trackId}: invisible raised ground at ${JSON.stringify(sample)}`)
      assert.ok(sample.delta >= -0.15, `${trackId}: visible road has a collision hole at ${JSON.stringify(sample)}`)
    }
    console.log(`PASS ${trackId}: ${result.samples.length} visible/physical road samples, worst difference ${Math.max(...result.samples.map(s => Math.abs(s.delta))).toFixed(3)}m`)
  }
} finally { await browser.close() }
