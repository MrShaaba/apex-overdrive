// Split-screen two-player test: fakes two pads through navigator.getGamepads, starts a
// two-player race (stacked, then side by side), drives both cars, checks both viewports
// render, both HUDs mount, per-player actions route to the right car, and samples the
// frame rate. Run: `npm run dev` then `node tests/split-screen.mjs` (APEX_URL / CHROME).
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
fs.mkdirSync('tests/shots', { recursive: true })
const SERVER = process.env.APEX_URL ?? 'http://localhost:5173/'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const width = 1280, height = 720
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-gpu-blocklist', `--window-size=${width},${height}`] })
const page = await browser.newPage(); await page.setViewport({ width, height, deviceScaleFactor: 1 })
page.on('console', (m) => { const t = m.text(); if (/\[Cockpit\]|error/i.test(t)) console.log('  >', t) })
await page.evaluateOnNewDocument(() => {
  const mk = (index, id, nAxes, nButtons) => ({ index, id, connected: true, mapping: 'standard', timestamp: 0, axes: new Array(nAxes).fill(0), buttons: Array.from({ length: nButtons }, () => ({ pressed: false, touched: false, value: 0 })) })
  const padA = mk(0, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 4, 17)
  const padB = mk(1, 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', 4, 17)
  window.__pads = { padA, padB, list: [padA, padB] }
  navigator.getGamepads = () => window.__pads.list.slice()
})
await page.goto(SERVER, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__apex && window.__apex.mode === 'showcase', { timeout: 60000 })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const setAxis = (dev, i, v) => page.evaluate((d, i, v) => { window.__pads[d].axes[i] = v }, dev, i, v)
const press = (dev, i, on) => page.evaluate((d, i, on) => { const b = window.__pads[d].buttons[i]; b.pressed = on; b.value = on ? 1 : 0 }, dev, i, on)
const tap = async (dev, i) => { await press(dev, i, true); await wait(80); await press(dev, i, false); await wait(80) }
let failures = 0
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++ }

// Race Setup UI: the Players toggle exists and exposes the layout + car picker.
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /all modes/i.test(x.innerText)); b && b.click() })
await wait(800)
const setupOk = await page.evaluate(async () => {
  const seg = [...document.querySelectorAll('.segmented__opt')].find((x) => /two players/i.test(x.innerText))
  if (!seg) return { found: false }
  seg.click()
  await new Promise((r) => setTimeout(r, 200))
  const layout = [...document.querySelectorAll('.segmented__opt')].some((x) => /side by side/i.test(x.innerText))
  const cars = document.querySelectorAll('[data-testid=p2-cars] button').length
  return { found: true, layout, cars }
})
console.log('race setup:', JSON.stringify(setupOk))
check(setupOk.found && setupOk.layout && setupOk.cars >= 1, 'Race Setup shows Players / layout / Player 2 car')
await page.screenshot({ path: 'tests/shots/split-setup.png' })

for (const layout of ['stack', 'side']) {
  await page.evaluate((layout) => window.__apex.startRace({ mode: 'quick', trackId: 'spa', carId: 'w13', carId2: 'mclaren-mcl35m', players: 2, splitLayout: layout, laps: 1, aiCount: 6, aiMix: 'mixed', difficulty: 'rookie', weather: 'clear', hour: 12, dynamicWeather: false, timeRate: 0, ghost: false, seed: 7 }), layout)
  await page.waitForFunction(() => window.__apex.race && window.__apex.race.phase === 'racing', { timeout: 90000 })
  const info = await page.evaluate(() => { const a = window.__apex; return { p1: a.player.spec.id, p2: a.player2 && a.player2.spec.id, cars: a.vehicles.length, split: a.split, huds: document.querySelectorAll('.hud').length, tags: [...document.querySelectorAll('.split__tag')].map((e) => e.innerText), racePlayer: a.race.player && a.race.player.vehicleId, p1id: a.player.id } })
  console.log(layout, JSON.stringify(info))
  check(info.p2 === 'mclaren-mcl35m' && info.cars === 8 && info.split === layout && info.huds === 2 && info.tags.join() === 'P1,P2' && info.racePlayer === info.p1id, `${layout}: two players, 6 AI, two HUDs, race.player is P1`)
  // Drive: P1 full throttle on pad A (RT), P2 on pad B.
  await press('padA', 7, true); await press('padB', 7, true)
  await wait(3500)
  const sp = await page.evaluate(() => ({ p1: window.__apex.player.controller.telemetry.speedKmh, p2: window.__apex.player2.controller.telemetry.speedKmh, fps: window.__apex.fps }))
  console.log(`${layout}: speeds P1 ${sp.p1.toFixed(0)} P2 ${sp.p2.toFixed(0)} km/h, fps ${sp.fps.toFixed(0)}`)
  check(sp.p1 > 40 && sp.p2 > 40, `${layout}: both cars accelerate from their own pads`)
  await page.screenshot({ path: `tests/shots/split-${layout}.png` })
  // Per-player camera: Y on pad B cycles only P2's camera.
  const before = await page.evaluate(() => [window.__apex.cameraRig.mode, window.__apex.cameraRig2.mode])
  await tap('padB', 3)
  await wait(200)
  const after = await page.evaluate(() => [window.__apex.cameraRig.mode, window.__apex.cameraRig2.mode])
  check(before[0] === after[0] && before[1] !== after[1], `${layout}: pad B camera button cycles player 2's camera only (${after.join('/')})`)
  // Cockpit views for both players.
  await page.evaluate(() => { window.__apex.setCamera('cockpit', 0); window.__apex.setCamera('cockpit', 1) })
  await wait(600)
  await page.screenshot({ path: `tests/shots/split-${layout}-cockpit.png` })
  await page.evaluate(() => { window.__apex.setCamera('chase', 0); window.__apex.setCamera('chase', 1) })
  // The two viewports must show different images (not one camera drawn twice): compare the
  // two halves of a screenshot with the HUD hidden.
  await page.evaluate(() => { document.querySelector('.ui-root').style.visibility = 'hidden' })
  const half = layout === 'stack' ? [{ x: 0, y: 0, width, height: height / 2 }, { x: 0, y: height / 2, width, height: height / 2 }] : [{ x: 0, y: 0, width: width / 2, height }, { x: width / 2, y: 0, width: width / 2, height }]
  const a = await page.screenshot({ clip: half[0], type: 'png' })
  const b = await page.screenshot({ clip: half[1], type: 'png' })
  await page.evaluate(() => { document.querySelector('.ui-root').style.visibility = '' })
  check(!a.equals(b), `${layout}: the two viewports show different views`)
  await press('padA', 7, false); await press('padB', 7, false)
  // fps sample over 2 s
  const fps = await page.evaluate(async () => { let n = 0; const t0 = performance.now(); await new Promise((r) => { const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r() }; requestAnimationFrame(f) }); return n / 2 })
  console.log(`${layout}: ~${fps.toFixed(0)} fps (headless, software GL)`)
  await page.evaluate(() => window.__apex.quitToMenu())
  await page.waitForFunction(() => window.__apex.mode === 'showcase', { timeout: 30000 })
  const cleared = await page.evaluate(() => ({ split: window.__apex.split, p2: window.__apex.player2 }))
  check(cleared.p2 === null, `${layout}: player 2 cleared after quitting`)
}
await browser.close()
console.log(failures ? `${failures} failure(s)` : 'split screen ok')
process.exit(failures ? 1 : 0)
