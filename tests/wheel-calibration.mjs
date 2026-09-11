// Fake-gamepad calibration test: installs a synthetic G29 (and optionally a pad) via
// navigator.getGamepads, opens Options → Controls, runs the calibration flow by driving the
// fake axes/buttons, saves, then starts a race and checks the inverted pedal axis drives the car.
// Run: `npm run dev` then `node tests/wheel-calibration.mjs` (APEX_URL / CHROME env overrides).
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
fs.mkdirSync('tests/shots', { recursive: true })
const SERVER = process.env.APEX_URL ?? 'http://localhost:5173/'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const width = 1280, height = 720
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-gpu-blocklist', `--window-size=${width},${height}`] })
const page = await browser.newPage(); await page.setViewport({ width, height, deviceScaleFactor: 1 })
page.on('console', (m) => { const t = m.text(); if (/\[Input\]|error/i.test(t)) console.log('  >', t) })
await page.evaluateOnNewDocument(() => {
  // Two fake devices: a G29 wheel (pedals resting at +1, pressed to -1; wheel on axis 0)
  // and an Xbox pad. window.__pads lets the test poke values.
  const mk = (index, id, nAxes, nButtons) => ({ index, id, connected: true, mapping: index === 1 ? 'standard' : '', timestamp: 0, axes: new Array(nAxes).fill(0), buttons: Array.from({ length: nButtons }, () => ({ pressed: false, touched: false, value: 0 })) })
  const wheel = mk(0, 'Logitech G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)', 4, 25)
  wheel.axes[2] = 1; wheel.axes[3] = 1 // pedals at rest
  const pad = mk(1, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 4, 17)
  window.__pads = { wheel, pad, list: [wheel, pad] }
  navigator.getGamepads = () => window.__pads.list.slice()
})
await page.goto(SERVER, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__apex && window.__apex.mode === 'showcase', { timeout: 60000 })
const click = async (re) => page.evaluate((src) => { const re = new RegExp(src, 'i'); const b = [...document.querySelectorAll('button')].find((x) => re.test(x.innerText) && !x.disabled); if (!b) return false; b.click(); return true }, re.source)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const setAxis = (dev, i, v) => page.evaluate((d, i, v) => { window.__pads[d].axes[i] = v }, dev, i, v)
const press = async (dev, i, on) => page.evaluate((d, i, on) => { const b = window.__pads[d].buttons[i]; b.pressed = on; b.value = on ? 1 : 0 }, dev, i, on)
const tap = async (dev, i) => { await press(dev, i, true); await wait(80); await press(dev, i, false); await wait(80) }

// Options → Controls
if (!(await click(/^options/))) { await click(/options/) }
await wait(800)
await click(/^controls$/) ; await wait(800)
const rows = await page.$$eval('[data-testid=device-row]', (els) => els.map((e) => e.innerText.replace(/\n/g, ' | ')))
console.log('device rows:', rows)
if (rows.length !== 2) { console.log('FAIL expected 2 device rows'); await browser.close(); process.exit(1) }
await page.evaluate(() => { const p = document.querySelector('.device-row'); p && p.scrollIntoView({ block: 'center' }) })
await page.screenshot({ path: 'tests/shots/wheel-panel.png' })

// Calibrate the wheel (first row's Calibrate button)
await page.evaluate(() => { const b = [...document.querySelectorAll('[data-testid=device-row]')[0].querySelectorAll('button')].find((x) => /calibrate/i.test(x.innerText)); b.click() })
await wait(400)
const prompt = async () => page.$eval('.calib__prompt', (e) => e.innerText)
console.log('step1:', await prompt())
await setAxis('wheel', 0, -0.98); await wait(150); await setAxis('wheel', 0, 0.97); await wait(150); await setAxis('wheel', 0, 0.0); await wait(150)
await page.screenshot({ path: 'tests/shots/wheel-calib-steer.png' })
await click(/^next$/); await wait(300); console.log('step2:', await prompt())
await setAxis('wheel', 2, -1); await wait(150); await setAxis('wheel', 2, 1); await wait(150)
await click(/^next$/); await wait(300); console.log('step3:', await prompt())
await setAxis('wheel', 3, -0.9); await wait(150); await setAxis('wheel', 3, 1); await wait(150)
await page.screenshot({ path: 'tests/shots/wheel-calib-brake.png' })
await click(/^next$/); await wait(300); console.log('step4:', await prompt())
await tap('wheel', 4); await wait(200); console.log('step5:', await prompt())
await tap('wheel', 5); await wait(200); console.log('step6:', await prompt())
await tap('wheel', 3); await wait(200); console.log('step7:', await prompt())
await tap('wheel', 9); await wait(300); console.log('step8:', await prompt())
await page.screenshot({ path: 'tests/shots/wheel-calib-done.png' })
await click(/^save$/); await wait(500)
const saved = await page.evaluate(() => JSON.stringify(window.__apex.settings.controls.devices))
console.log('saved:', saved)
const prof = JSON.parse(saved)['Logitech G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)']
const ok1 = prof && prof.calibrated && prof.steer.axis === 0 && prof.throttle.axis === 2 && prof.throttle.min === 1 && prof.throttle.max === -1 && prof.brake.axis === 3 && prof.buttons.gearUp === 4 && prof.buttons.gearDown === 5 && prof.buttons.camera === 3 && prof.buttons.pause === 9
console.log(ok1 ? 'PASS profile saved as expected' : 'FAIL profile mismatch')
// Assign pad to P2 via the row buttons
await page.evaluate(() => { const b = [...document.querySelectorAll('[data-testid=device-row]')[1].querySelectorAll('button')].find((x) => /^P2$/.test(x.innerText)); b.click() })
await wait(600)
const players = await page.evaluate(() => JSON.stringify(window.__apex.settings.controls.players))
console.log('players:', players)
await page.screenshot({ path: 'tests/shots/wheel-panel-assigned.png' })

// Race: press the wheel's throttle and check the car accelerates; pad steer feeds player 2.
await page.evaluate(() => window.__apex.startRace({ mode: 'quick', trackId: 'lakeside', carId: 'w13', laps: 1, aiCount: 0, aiMix: 'class', difficulty: 'rookie', weather: 'clear', hour: 12, dynamicWeather: false, timeRate: 0, ghost: false, seed: 1 }))
await page.waitForFunction(() => window.__apex.race && window.__apex.race.phase === 'racing', { timeout: 60000 })
await setAxis('wheel', 2, -1) // throttle floored, wheel straight
await wait(3000)
const speed = await page.evaluate(() => window.__apex.player.controller.telemetry.speedKmh)
console.log('speed after 3 s full throttle (wheel): km/h', speed.toFixed(1))
await setAxis('wheel', 0, 0.5)
await setAxis('pad', 0, -0.8)
await wait(400)
const st = await page.evaluate(() => { const i = window.__apex.input; return { p1: { ...i.getState(0) }, p2: { ...i.getState(1) } } })
console.log('p1 state:', JSON.stringify(st.p1), '\np2 state:', JSON.stringify(st.p2))
const ok2 = st.p1.throttle > 0.95 && st.p1.steer > 0.4 && st.p2.steer < -0.6 && speed > 30
await page.screenshot({ path: 'tests/shots/wheel-race.png' })
await setAxis('wheel', 0, 0)
console.log(ok2 ? 'PASS race input' : 'FAIL race input')
// Edge action: wheel pause button 9 → pause
await tap('wheel', 9); await wait(300)
const paused = await page.evaluate(() => !!document.querySelector('.pause__title'))
console.log('paused after wheel pause button:', paused, paused ? 'PASS' : 'FAIL')
await browser.close()
process.exit(ok1 && ok2 && paused ? 0 : 1)
