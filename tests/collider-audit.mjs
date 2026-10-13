#!/usr/bin/env node
/**
 * Collider audit: on every circuit, samples the drivable band (every 2 m along the
 * lap, every 2 m across between the kerbs) with a box 5 cm to 1.45 m above the road
 * and fails if an invisible non-ground collider intersects it. Visible walls and
 * deliberate hazards are reported separately. Ground
 * colliders (road, kerb, run-off, the nets) are allowed; those whose top sits more
 * than 25 cm above the road at the same spot are reported as steps.
 *
 * The test runner starts the server and discovers Chrome automatically:
 *   npm test -- collider-audit
 * For individual circuits against a running server:
 *   APEX_URL=http://127.0.0.1:5173 node tests/collider-audit.mjs spa sepang
 */
import puppeteer from 'puppeteer-core'

const SERVER = process.env.APEX_URL ?? 'http://localhost:5173/'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'))

try { await fetch(SERVER) } catch { console.error(`no dev server at ${SERVER} — run \`npm run dev\` first (or set APEX_URL)`); process.exit(2) }
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-gpu-blocklist', '--window-size=960,540'] })
const page = await browser.newPage()
await page.setViewport({ width: 960, height: 540 })
page.on('pageerror', (e) => console.error('page error:', e.message))
await page.goto(SERVER, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__apex && window.__apex.mode === 'showcase', { timeout: 60000 })
const tracks = wanted.length ? wanted : await page.evaluate(async () => (await import('/src/game/tracks/TrackCatalog.ts')).TRACK_CATALOG.map(t => t.id))

let failures = 0
for (const trackId of tracks) {
  await page.evaluate((t) => window.__apex.startRace({ mode: 'quick', trackId: t, carId: 'mercedes-w13', laps: 1, aiCount: 0, aiMix: 'pro', difficulty: 'pro', weather: 'clear', hour: 'default', dynamicWeather: false, timeRate: 0, ghost: false, seed: 1 }), trackId)
  await page.waitForFunction(() => window.__apex.mode === 'race' && window.__apex.player, { timeout: 180000 })
  await new Promise((r) => setTimeout(r, 500))
  const result = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js')
    const e = window.__apex, R = e.physics.RAPIER, world = e.physics.world, sp = e.track.spline
    const caster = new THREE.Raycaster()
    // Look for a mesh anywhere from 4 m above the road down to 2 cm above it: a ray that
    // started inside a tall box would miss its back-face-culled far side.
    const visibleAt = (x, ground, z) => { caster.set(new THREE.Vector3(x, ground + 4, z), new THREE.Vector3(0, -1, 0)); caster.far = 3.98; const hits = caster.intersectObjects(e.scene.children, true); return hits.some((h) => h.object.visible && h.object.isMesh && h.object.name !== 'collider-debug' && !/^wheel|^body|car-/.test(h.object.name)) }
    world.updateSceneQueries()
    const VEHICLE = 0x0002
    const groups = ((0xffff & ~VEHICLE) << 16) | (0xffff & ~VEHICLE) // query is "everything but cars"
    const q = new R.Quaternion(0, 0, 0, 1)
    const bad = new Map(), steps = new Map(), edge = new Map()
    let samples = 0
    const hw = (i) => (typeof e.track.halfWidthAt === 'function' ? e.track.halfWidthAt(i) : e.track.halfWidth)
    for (let i = 0; i < sp.samples.length; i += 1) {
      const s = sp.samples[i]
      const half = Math.max(2, hw(i) - 0.5)
      // orientation: tangent → +Z, right → +X, up → +Y
      const t = s.tangent, r = s.right, u = s.up
      // quaternion from basis (columns r, u, t)
      const m00 = r.x, m01 = u.x, m02 = t.x, m10 = r.y, m11 = u.y, m12 = t.y, m20 = r.z, m21 = u.z, m22 = t.z
      const tr = m00 + m11 + m22
      let qx, qy, qz, qw
      if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; qw = 0.25 * S; qx = (m21 - m12) / S; qy = (m02 - m20) / S; qz = (m10 - m01) / S }
      else if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; qw = (m21 - m12) / S; qx = 0.25 * S; qy = (m01 + m10) / S; qz = (m02 + m20) / S }
      else if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; qw = (m02 - m20) / S; qx = (m01 + m10) / S; qy = 0.25 * S; qz = (m12 + m21) / S }
      else { const S = Math.sqrt(1 + m22 - m00 - m11) * 2; qw = (m10 - m01) / S; qx = (m02 + m20) / S; qy = (m12 + m21) / S; qz = 0.25 * S }
      q.x = qx; q.y = qy; q.z = qz; q.w = qw
      // One box per sample spanning the band a metre inside each kerb (walls stand at the
      // kerb; a probe that overhung the edge caught every barrier beside the road).
      const bandHalf = Math.max(1, half - 0.5)
      for (const lat of [0]) {
        samples++
        const cx = s.position.x + r.x * lat, cy = s.position.y, cz = s.position.z + r.z * lat
        // road height here: first ground hit from above
        let ground = NaN, groundHandle = -1
        world.intersectionsWithRay(new R.Ray({ x: cx, y: cy + 5, z: cz }, { x: 0, y: -1, z: 0 }), 12, true, (h) => { const meta = e.physics.getMeta(h.collider.handle); const y = cy + 5 - h.timeOfImpact; if (meta?.surface && !meta.wall && !(ground >= y)) { ground = y; groundHandle = h.collider.handle } return true }, undefined, groups)
        if (!Number.isFinite(ground)) continue
        const box = new R.Cuboid(bandHalf, 0.7, 1.0)
        const centre = { x: cx + u.x * 0.75, y: ground + 0.05 + 0.7, z: cz + u.z * 0.75 }
        world.intersectionsWithShape(centre, q, box, (col) => {
          const meta = e.physics.getMeta(col.handle)
          const membership = (col.collisionGroups() >>> 16) & 0xffff
          // Ground: anything registered with a surface that is not a wall (roads, kerbs,
          // run-off, nets, jump ramps). Walls and props are only a problem inside the band.
          const isGround = !!(meta?.surface && !meta.wall)
          if (col.isSensor()) return true
          if (!isGround) {
            // Pin it down: vertical rays through the box, 0.5 m apart, that hit this collider
            // between 5 cm and 1.45 m above the road give its exact lateral offset. A collider
            // whose shape test touches the box but that no ray meets is a grazing edge, not a
            // thing on the road.
            let hitLat = NaN, hitAlong = NaN, hitTop = NaN
            outer: for (let l2 = -bandHalf; l2 <= bandHalf + 0.01; l2 += 0.5) for (let a2 = -1; a2 <= 1.01; a2 += 0.5) {
              const px = cx + r.x * l2 + t.x * a2, pz = cz + r.z * l2 + t.z * a2
              let hit = NaN
              world.intersectionsWithRay(new R.Ray({ x: px, y: ground + 1.45, z: pz }, { x: 0, y: -1, z: 0 }), 1.4, true, (h) => { if (h.collider.handle === col.handle) { hit = ground + 1.45 - h.timeOfImpact; return false } return true }, undefined, groups)
              if (Number.isFinite(hit)) { hitLat = l2; hitAlong = a2; hitTop = hit - ground; break outer }
            }
            if (!Number.isFinite(hitLat)) return true
            // Is there a visible mesh where the collider is? A barrier, prop or hazard the
            // player can see is a track feature (reported, not failed); a collider with no
            // mesh is the bug this audit exists for.
            const px = cx + r.x * hitLat + t.x * hitAlong, pz = cz + r.z * hitLat + t.z * hitAlong
            // Hazards (swinging crane loads, gates, bales) are built with their mesh in the same
            // call as their collider; a thin cable can dodge one ray, so they are reported, not failed.
            const visible = (membership & 0x0008) !== 0 || visibleAt(px, ground, pz)
            const store = visible ? edge : bad
            const key = col.handle
            if (!store.has(key)) store.set(key, { handle: col.handle, meta: meta ?? null, membership, shape: col.shapeType(), at: [Math.round(px), Math.round(ground), Math.round(pz)], dist: Math.round(s.distance), lat: +hitLat.toFixed(1), top: +hitTop.toFixed(2), count: 0 })
            store.get(key).count++
          } else if (col.handle !== groundHandle) {
            // another ground collider inside the band volume: a step if its top is > 25 cm up
            let top = NaN
            world.intersectionsWithRay(new R.Ray({ x: cx, y: cy + 5, z: cz }, { x: 0, y: -1, z: 0 }), 12, true, (h) => { if (h.collider.handle === col.handle) top = cy + 5 - h.timeOfImpact; return true }, undefined, groups)
            if (Number.isFinite(top) && top - ground > 0.25) { const key = col.handle; if (!steps.has(key)) steps.set(key, { handle: col.handle, surface: meta.surface, rise: +(top - ground).toFixed(2), dist: Math.round(s.distance), lat: Math.round(lat), count: 0 }); steps.get(key).count++ }
          }
          return true
        }, undefined, groups)
      }
    }
    return { samples, lap: Math.round(sp.length), bad: [...bad.values()], steps: [...steps.values()], edge: [...edge.values()] }
  })
  const ok = result.bad.length === 0
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${trackId.padEnd(18)} lap ${result.lap} m, ${result.samples} samples, ${result.bad.length} invisible collider(s) on the band, ${result.steps.length} step(s), ${result.edge.length} visible obstacle(s) inside the band`)
  for (const b of result.bad) console.log(`   INVISIBLE: handle ${b.handle} groups 0x${b.membership.toString(16)} shape ${b.shape} meta ${JSON.stringify(b.meta)} at ${b.dist} m lat ${b.lat} top +${b.top} m (${b.at.join(',')}) × ${b.count}`)
  for (const st of result.steps) console.log(`   step: ${st.surface} +${st.rise} m at ${st.dist} m lat ${st.lat} × ${st.count}`)
  for (const w of result.edge.slice(0, 8)) console.log(`   visible: ${w.meta?.hazardId ? 'hazard ' + w.meta.hazardId : w.meta?.wall ? 'wall' : 'prop'} shape ${w.shape} at ${w.dist} m lat ${w.lat} top +${w.top} m × ${w.count}`)
}
await browser.close()
if (failures) { console.error(`${failures} circuit(s) have invisible colliders on the racing surface`); process.exit(1) }
console.log('all circuits clean')
