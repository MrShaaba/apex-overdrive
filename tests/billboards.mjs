// Fam Jam billboards: loads the Sepang - Fam Jam variant, checks board placement
// (count, spacing, off the road, not on the pit side of the pit lane, photos cycling),
// screenshots a board from the chase and cockpit cameras (day and night), compares the
// frame rate with plain Sepang, and confirms the track still loads with blank boards
// when the photo folder is missing.
// Run: `npm run dev` then `node tests/billboards.mjs` (APEX_URL / CHROME env overrides).
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'
fs.mkdirSync('tests/shots', { recursive: true })
const SERVER = process.env.APEX_URL ?? 'http://localhost:5173/'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TRACK = 'sepang-fam-jam'
const BASE = 'sepang'
const PHOTOS = path.resolve('public/assets/photos/fam-jam')
const width = 1280, height = 720
let failures = 0
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++ }
// Photos are personal and gitignored. On a fresh clone the boards are blank, so checks that need photos are skipped.
const HAS_PHOTOS = fs.existsSync(PHOTOS) && fs.readdirSync(PHOTOS).some((f) => /manifest/i.test(f))
const photoCheck = (ok, label) => HAS_PHOTOS ? check(ok, label) : console.log(`SKIP ${label} (no photos in public/assets/photos/fam-jam)`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const launch = async (extraArgs = []) => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-gpu-blocklist', `--window-size=${width},${height}`, ...extraArgs] })
  const page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { const t = m.text(); if (/\[Billboards\]|Frame error|error/i.test(t)) { if (/Frame error|Uncaught|TypeError/.test(t)) errors.push(t); else console.log('  >', t.replace(/%c/g, '').replace(/color:#[0-9a-f]+ ?/g, '').slice(0, 160)) } })
  await page.goto(SERVER, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__apex && window.__apex.mode === 'showcase', { timeout: 60000 })
  return { browser, page, errors }
}
const start = (page, trackId, hour = 13) => page.evaluate((t, h) => window.__apex.startRace({ mode: 'quick', trackId: t, carId: 'mercedes-w13', laps: 2, aiCount: 0, aiMix: 'pro', difficulty: 'pro', weather: 'clear', hour: h, dynamicWeather: false, timeRate: 0, ghost: false, seed: 1 }), trackId, hour)
const waitRacing = (page) => page.waitForFunction(() => window.__apex.race && window.__apex.race.phase === 'racing', { timeout: 120000 })

// --- 1. Placement ------------------------------------------------------------------
{
  const { browser, page, errors } = await launch()
  // The variant is its own selectable circuit in Race Setup.
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((x) => /all modes/i.test(x.innerText)), { timeout: 20000 })
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /all modes/i.test(x.innerText)); b && b.click() })
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 5, { timeout: 20000 })
  // innerText carries the CSS text-transform (upper case), hence the case-insensitive match.
  const card = await page.evaluate(() => { const c = [...document.querySelectorAll('.card')].find((c) => /fam jam/i.test(c.innerText)); if (c) c.scrollIntoView({ block: 'center' }); return !!c })
  check(card, 'Race Setup lists the Fam Jam variant as its own circuit')
  await wait(300)
  await page.screenshot({ path: 'tests/shots/billboards-setup.png' })
  await start(page, TRACK)
  await waitRacing(page)
  const info = await page.evaluate(() => {
    const t = window.__apex.track, bb = t.billboards, sp = t.spline
    if (!bb) return null
    const placed = bb.placed.map((b) => {
      const i = sp.nearestIndex(b.position); const s = sp.samples[i]
      const dx = b.position.x - s.position.x, dz = b.position.z - s.position.z
      const lateral = Math.abs(dx * s.right.x + dz * s.right.z)
      return { dist: Math.round(b.distance), side: b.side, photo: b.photo, lateral: +lateral.toFixed(1), hw: t.halfWidthAt(i), inPit: !!(t.pitZone && b.side === t.pitZone.side && (t.pitZone.from <= t.pitZone.to ? b.distance >= t.pitZone.from && b.distance <= t.pitZone.to : b.distance >= t.pitZone.from || b.distance <= t.pitZone.to)) }
    })
    const names = {}
    bb.root.children.forEach((o) => { names[o.name] = (names[o.name] ?? 0) + 1 })
    const set = window.__apex.track.billboards.set
    return { count: placed.length, placed, names, lap: Math.round(sp.length), name: t.def.name, setSize: set.photos.length, captioned: set.photos.filter((p) => p.caption).length }
  })
  check(!!info, 'track builds a billboards result')
  if (info) {
    console.log(`${info.name}: ${info.count} boards on a ${info.lap} m lap; meshes ${JSON.stringify(info.names)}`)
    console.log('  ' + info.placed.map((p) => `${p.dist}m${p.side > 0 ? 'R' : 'L'}#${p.photo}@${p.lateral}`).join(' '))
    check(info.count >= 16, `at least 16 of 24 boards placed (${info.count})`)
    check(info.placed.every((p) => p.lateral >= p.hw + 4.5), 'every board is at least 4.5 m outside the road edge')
    check(info.placed.every((p) => !p.inPit), 'no board on the pit side of the pit lane')
    const gaps = info.placed.slice(1).map((p, i) => p.dist - info.placed[i].dist)
    check(gaps.every((g) => g >= 90), `boards at least 90 m apart (min ${Math.min(...gaps)} m)`)
    const photos = info.placed.map((p) => p.photo)
    photoCheck(new Set(photos).size === Math.min(info.count, info.setSize), `no photo on two boards at once (${new Set(photos).size} distinct on ${info.count} boards, set of ${info.setSize})`)
    check(info.names['billboard-frame'] > 0 && info.names['billboard-panel'] > 0, 'frame and panel instanced meshes present')
    check((info.names['billboard-caption'] ?? 0) === (info.captioned ? info.names['billboard-panel'] : 0) || info.captioned, `caption strips only where photos have captions (${info.names['billboard-caption'] ?? 0} strips, ${info.captioned} captioned photos)`)
    // Colliders: a prop collider sits where each board's frame is, and none reaches the road.
    const col = await page.evaluate(() => {
      const a = window.__apex, t = a.track, world = a.physics.world, R = a.physics.RAPIER
      world.updateSceneQueries()
      const groups = (2 << 16) | (4 | 8 | 16)
      let framed = 0, road = 0
      for (const b of t.billboards.placed) {
        let hit = false
        world.intersectionsWithShape({ x: b.position.x, y: b.position.y + 2.5, z: b.position.z }, { x: 0, y: 0, z: 0, w: 1 }, new R.Cuboid(0.3, 1.5, 0.3), (c) => { const m = a.physics.getMeta(c.handle); if (m && m.wall) hit = true; return !hit }, undefined, groups)
        if (hit) framed++
        // The road edge nearest the board: no prop collider within the drivable band there.
        const i = t.spline.nearestIndex(b.position); const s = t.spline.samples[i]; const hw = t.halfWidthAt(i)
        for (const lat of [-(hw - 1), 0, hw - 1]) {
          const x = s.position.x + s.right.x * lat, z = s.position.z + s.right.z * lat
          world.intersectionsWithShape({ x, y: s.position.y + 1, z }, { x: 0, y: 0, z: 0, w: 1 }, new R.Cuboid(1, 1, 3), (c) => { const m = a.physics.getMeta(c.handle); if (m && m.wall) road++; return false }, undefined, groups)
        }
      }
      return { framed, road, total: t.billboards.placed.length }
    })
    check(col.framed === col.total, `every board has a frame/leg collider (${col.framed}/${col.total})`)
    check(col.road === 0, `no prop collider inside the drivable band beside a board (${col.road})`)
  }
  check(errors.length === 0, `no page errors while racing (${errors.length})`)

  // Screenshots: 65 m before the fourth board, chase then cockpit, then the same at night.
  const shot = async (mode, hour, file) => {
    await page.evaluate((mode) => window.__apex.setCamera(mode, 0), mode)
    await page.evaluate((hour) => { const a = window.__apex; const b = a.track.billboards.placed[3]; const s = a.track.spawnPose((b.distance - 65 + a.track.spline.length) % a.track.spline.length, 0); a.player.respawn(s.position, s.quaternion); a.sky.hour = hour }, hour)
    await wait(900)
    await page.screenshot({ path: `tests/shots/${file}` })
  }
  await shot('chase', 13, 'billboards-chase.png')
  await shot('cockpit', 13, 'billboards-cockpit.png')
  await shot('chase', 22, 'billboards-chase-night.png')
  // Close-up: park 17 m from the board, facing it.
  await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js')
    const a = window.__apex, t = a.track, sp = t.spline, b = t.billboards.placed[3]
    const s0 = sp.atDistance((b.distance - 10 + sp.length) % sp.length)
    const eye = s0.position.clone().addScaledVector(s0.right, b.side * 2); eye.y += 0.9
    const dir = new THREE.Vector3().subVectors(b.position, eye); dir.y = 0; dir.normalize()
    a.player.respawn(eye, new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), dir.negate(), new THREE.Vector3(0, 1, 0))))
    a.setCamera('chase', 0); a.sky.hour = 13
  })
  await wait(1000)
  await page.screenshot({ path: 'tests/shots/billboards-closeup.png' })
  await page.evaluate(() => { window.__apex.sky.hour = 22 })
  await wait(700)
  await page.screenshot({ path: 'tests/shots/billboards-closeup-night.png' })
  await page.evaluate(() => { window.__apex.sky.hour = 13 })
  // Texture lifecycle: photos and captions live in the TextureFactory cache while the
  // track is loaded and are released with it.
  const keys = () => page.evaluate(() => { const c = window.__apex.textures.cache; const ks = [...c.keys()]; return { image: ks.filter((k) => k.startsWith('image:')).length, caption: ks.filter((k) => k.startsWith('caption:')).length, loaded: ks.filter((k) => k.startsWith('image:')).filter((k) => c.get(k).texture.image && c.get(k).texture.image.width > 2).length } })
  const during = await keys()
  photoCheck(during.image >= 1, `photo textures cached while racing (${during.image} images, ${during.caption} captions)`)
  check(during.loaded === during.image, `every photo texture finished loading (${during.loaded}/${during.image})`)
  // Rotation: drive (teleport) round the lap twice; boards left well behind take the next
  // photo, no photo is ever on two boards at once, and the whole set gets shown.
  const rot = await page.evaluate(async () => {
    const a = window.__apex, t = a.track, bb = t.billboards, sp = t.spline
    const n = bb.set.photos.length
    const before = bb.placed.map((b) => b.photo)
    let dupes = 0, swaps = 0
    for (let d = 0; d < sp.length * 2.2; d += 150) {
      const s = t.spawnPose(d % sp.length, 0)
      a.player.respawn(s.position, s.quaternion)
      await new Promise((r) => setTimeout(r, 120))
      const now = bb.placed.map((b) => b.photo)
      if (new Set(now).size < Math.min(now.length, n)) dupes++
      swaps += now.filter((p, i) => p !== before[i]).length
      before.splice(0, before.length, ...now)
    }
    return { n, boards: bb.placed.length, shown: bb.shown.size, dupes, swaps, cursor: bb.cursor, stored: localStorage.getItem('apex.photos.cursor:' + bb.set.folder) }
  })
  console.log(`rotation: ${rot.n} photos on ${rot.boards} boards, ${rot.swaps} swaps over 2.2 laps, ${rot.shown} distinct photos shown, cursor ${rot.cursor} (stored ${rot.stored})`)
  photoCheck(rot.swaps >= rot.boards, 'boards take new photos as the player laps')
  photoCheck(rot.dupes === 0, 'no photo on two boards at once at any point')
  photoCheck(rot.shown === rot.n, `every photo in the set was shown (${rot.shown}/${rot.n})`)
  photoCheck(String(rot.cursor) === rot.stored, 'photo cursor persisted for the next session')
  await page.evaluate(() => window.__apex.quitToMenu())
  await page.waitForFunction(() => window.__apex.mode === 'showcase', { timeout: 60000 })
  const after = await keys()
  check(after.image === 0 && after.caption === 0, `photo and caption textures released with the track (${after.image} images, ${after.caption} captions left)`)
  await browser.close()
}

// --- 2. Frame rate: variant vs the circuit it was cloned from --------------------------
{
  const { browser, page } = await launch(['--disable-frame-rate-limit', '--disable-gpu-vsync'])
  const measure = async (trackId) => {
    await start(page, trackId)
    await waitRacing(page)
    await page.evaluate(() => { window.__apex.setAutopilot(true); window.__apex.setCamera('chase', 0) })
    await wait(2000)
    return page.evaluate(async () => { let n = 0; const t0 = performance.now(); await new Promise((r) => { const f = () => { n++; if (performance.now() - t0 < 6000) requestAnimationFrame(f); else r() }; requestAnimationFrame(f) }); return n / 6 })
  }
  const base = await measure(BASE)
  const untouched = await page.evaluate(() => window.__apex.track.def.photoBillboards === undefined && window.__apex.track.billboards === null && window.__apex.track.def.id === 'sepang')
  check(untouched, `plain ${BASE} builds no billboards and carries no photoBillboards field`)
  const variant = await measure(TRACK)
  console.log(`fps: ${BASE} ${base.toFixed(0)}, ${TRACK} ${variant.toFixed(0)} (uncapped, 6 s on autopilot)`)
  check(variant >= base * 0.9, `variant frame rate within 10 % of ${BASE}`)
  await browser.close()
}

// --- 3. Graceful absence: no photo folder → blank boards, no errors ----------------------
{
  const off = `${PHOTOS}.off`
  const had = fs.existsSync(PHOTOS)
  if (had) fs.renameSync(PHOTOS, off)
  try {
    const { browser, page, errors } = await launch()
    await start(page, TRACK)
    await waitRacing(page)
    const info = await page.evaluate(() => { const bb = window.__apex.track.billboards; return { count: bb.placed.length, blank: bb.placed.every((b) => b.photo === -1), captions: bb.root.children.filter((o) => o.name === 'billboard-caption').length } })
    console.log(`without photos: ${info.count} boards, blank ${info.blank}, caption meshes ${info.captions}`)
    check(info.count >= 16 && info.blank && info.captions === 0, 'track loads with plain blank boards when the manifest is missing')
    check(errors.length === 0, `no page errors without photos (${errors.length})`)
    await page.evaluate(() => { const a = window.__apex; const b = a.track.billboards.placed[3]; const s = a.track.spawnPose((b.distance - 65 + a.track.spline.length) % a.track.spline.length, 0); a.player.respawn(s.position, s.quaternion) })
    await wait(900)
    await page.screenshot({ path: 'tests/shots/billboards-blank.png' })
    await browser.close()
  } finally {
    if (had) fs.renameSync(off, PHOTOS)
  }
}

console.log(failures ? `${failures} failure(s)` : 'billboards ok')
process.exit(failures ? 1 : 0)
