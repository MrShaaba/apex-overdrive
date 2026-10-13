// Two identical G29-class wheels with integrated pedals: UI calibration, saved instance
// profiles, reload, split input, paddles/cameras/pause and disconnect/reconnect routing.
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
fs.mkdirSync('tests/shots', { recursive: true })
const SERVER = process.env.APEX_URL ?? 'http://localhost:5173/'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-gpu-blocklist', '--window-size=1280,720'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.evaluateOnNewDocument(() => {
    const id = 'Logitech G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)'
    const mk = (index) => ({ index, id, connected: true, mapping: '', timestamp: 0, axes: [0, 0, 1, 1], buttons: Array.from({ length: 25 }, () => ({ pressed: false, touched: false, value: 0 })) })
    const wheel = mk(0), second = mk(1)
    window.__pads = { wheel, second, list: [wheel, second] }
    navigator.getGamepads = () => window.__pads.list.slice()
  })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const boot = () => page.waitForFunction(() => window.__apex?.mode === 'showcase', { timeout: 60000 })
  const click = async (pattern) => {
    const found = await page.evaluate((source) => {
      const re = new RegExp(source, 'i')
      const button = [...document.querySelectorAll('button')].find((b) => re.test(b.innerText) && !b.disabled)
      button?.click(); return !!button
    }, pattern.source)
    assert.ok(found, `Button ${pattern} exists and is enabled`)
  }
  const axis = (dev, index, value) => page.evaluate((dev, index, value) => { window.__pads[dev].axes[index] = value }, dev, index, value)
  const press = (dev, index, on) => page.evaluate((dev, index, on) => { const button = window.__pads[dev].buttons[index]; button.pressed = on; button.value = on ? 1 : 0 }, dev, index, on)
  const tap = async (dev, index) => { await press(dev, index, true); await wait(120); await press(dev, index, false); await wait(120) }
  const openControls = async () => { await click(/options/); await wait(500); await click(/^controls$/); await wait(500) }
  await page.goto(SERVER, { waitUntil: 'domcontentloaded' }); await boot(); await openControls()
  assert.equal(await page.$$eval('[data-testid=device-row]', (rows) => rows.length), 2)
  await page.evaluate(() => document.querySelector('.controller-device').scrollIntoView({ block: 'center' }))
  await page.screenshot({ path: 'tests/shots/wheel-panel.png' })
  async function calibrate(dev, row, center, buttons) {
    await page.evaluate((row) => {
      const button = [...document.querySelectorAll('[data-testid=device-row]')[row].querySelectorAll('button')].find((b) => /calibrate/i.test(b.innerText)); button.click()
    }, row)
    await wait(250)
    await axis(dev, 0, -0.98); await wait(180); await axis(dev, 0, 0.97); await wait(180); await axis(dev, 0, center); await wait(180)
    await click(/^next$/); await wait(150)
    await axis(dev, 2, -1); await wait(180); await axis(dev, 2, 1); await wait(180)
    await click(/^next$/); await wait(150)
    await axis(dev, 3, -0.9); await wait(180); await axis(dev, 3, 1); await wait(180)
    await click(/^next$/); await wait(150)
    for (const button of buttons) await tap(dev, button)
    await page.waitForFunction(() => document.querySelector('.calib__prompt')?.textContent?.startsWith('Review'), { timeout: 10000 })
    await page.screenshot({ path: `tests/shots/wheel-calib-${dev}.png` })
    await click(/^save$/); await wait(400)
  }
  await calibrate('wheel', 0, 0, [4, 5, 3, 9])
  await calibrate('second', 1, 0.04, [6, 7, 12, 13])
  for (const row of [0, 1]) {
    await page.evaluate((row) => {
      const button = [...document.querySelectorAll('[data-testid=device-row]')[row].querySelectorAll('button')].find((b) => b.innerText === `P${row + 1}`); button.click()
    }, row)
    await wait(300)
  }
  const profiles = await page.evaluate(() => {
    const controls = window.__apex.settings.controls
    return { players: controls.players, devices: controls.devices, pedals: controls.pedals }
  })
  assert.notEqual(profiles.players[0], profiles.players[1])
  const first = profiles.devices[profiles.players[0]], second = profiles.devices[profiles.players[1]]
  assert.ok(first.calibrated && second.calibrated)
  assert.equal(first.steer.center, 0); assert.equal(second.steer.center, 0.04)
  assert.equal(first.throttle.axis, 2); assert.equal(first.throttle.min, 1); assert.equal(first.throttle.max, -1)
  assert.equal(first.buttons.gearUp, 4); assert.equal(second.buttons.gearUp, 6)
  assert.deepEqual(profiles.pedals, [null, null])
  console.log('PASS two identical wheels have independent calibrated profiles and explicit player assignments')
  await page.evaluate(() => {
    const details = document.querySelector('.controller-device details'); details.open = true; details.scrollIntoView({ block: 'start' })
  })
  await axis('wheel', 0, 0.5); await axis('wheel', 2, -1); await wait(400)
  const live = await page.evaluate(() => [...document.querySelector('.controller-device').querySelectorAll('meter')].map((m) => m.value))
  assert.ok(live[0] > 0.4 && live[1] === 1 && live[2] === 0, `live steering/throttle/brake ${live}`)
  await page.screenshot({ path: 'tests/shots/wheel-tuning.png' })
  await axis('wheel', 0, 0); await axis('wheel', 2, 1)
  await page.reload({ waitUntil: 'domcontentloaded' }); await boot()
  const persisted = await page.evaluate(() => window.__apex.settings.controls)
  assert.deepEqual(persisted.players, profiles.players)
  assert.deepEqual(persisted.devices, profiles.devices)
  console.log('PASS independent wheel calibration and assignments survive page reload')
  await axis('second', 0, 0.04)
  await page.evaluate(() => {
    const engine = window.__apex
    engine.applySettings({ ...engine.settings, controls: { ...engine.settings.controls, transmission: 'manual' } })
    return engine.startRace({ mode: 'quick', trackId: 'lakeside-circuit', carId: 'mercedes-w13', carId2: 'mercedes-w13', players: 2, splitLayout: 'side', laps: 1, aiCount: 0, aiMix: 'class', difficulty: 'rookie', weather: 'clear', hour: 12, dynamicWeather: false, timeRate: 0, ghost: false, seed: 1 })
  })
  await page.waitForFunction(() => window.__apex.race?.phase === 'racing', { timeout: 60000 })
  await axis('wheel', 2, -1); await axis('second', 2, 0.2); await wait(3000)
  const drive = await page.evaluate(() => {
    const a = window.__apex
    return { p1: { ...a.input.getState(0) }, p2: { ...a.input.getState(1) }, speed1: a.player.controller.telemetry.speedKmh, speed2: a.player2.controller.telemetry.speedKmh, cars: [a.player.spec.id, a.player2.spec.id] }
  })
  assert.equal(drive.p1.throttle, 1); assert.ok(drive.p2.throttle > 0.35 && drive.p2.throttle < 0.45)
  assert.ok(drive.p1.directSteering && drive.p2.directSteering)
  assert.ok(drive.speed1 > 25 && drive.speed2 > 5, JSON.stringify(drive))
  assert.deepEqual(drive.cars, ['mercedes-w13', 'mercedes-w13'])
  console.log(`PASS identical integrated wheel+pedal devices independently drive both split cars (${drive.speed1.toFixed(1)} / ${drive.speed2.toFixed(1)} km/h)`)
  await axis('wheel', 0, 0.5); await axis('second', 0, -0.6); await wait(150)
  const steer = await page.evaluate(() => [window.__apex.input.getState(0).steer, window.__apex.input.getState(1).steer])
  assert.ok(steer[0] > 0.4 && steer[1] < -0.5)
  await axis('wheel', 0, 0); await axis('second', 0, 0.04)
  await axis('wheel', 2, 1); await axis('second', 2, 1)
  const before = await page.evaluate(() => [window.__apex.cameraRig.mode, window.__apex.cameraRig2.mode])
  await tap('second', 12)
  const after = await page.evaluate(() => [window.__apex.cameraRig.mode, window.__apex.cameraRig2.mode])
  assert.equal(after[0], before[0]); assert.notEqual(after[1], before[1])
  const gears = await page.evaluate(() => [window.__apex.player.controller.telemetry.gear, window.__apex.player2.controller.telemetry.gear])
  await tap('second', 6); await wait(300)
  const shifted = await page.evaluate(() => [window.__apex.player.controller.telemetry.gear, window.__apex.player2.controller.telemetry.gear])
  assert.equal(shifted[0], gears[0]); assert.equal(shifted[1], gears[1] + 1)
  console.log('PASS independent steering, camera buttons and shift paddles route to the correct car')
  await page.screenshot({ path: 'tests/shots/dual-wheels-race.png' })
  await tap('wheel', 9); assert.equal(await page.evaluate(() => window.__apex.paused), true)
  await tap('wheel', 9); assert.equal(await page.evaluate(() => window.__apex.paused), false)
  await page.evaluate(() => { window.__pads.list[0] = null }); await wait(250)
  assert.equal(await page.evaluate(() => window.__apex.paused), true)
  const remaining = await page.evaluate(() => window.__apex.input.listDevices().map((d) => ({ index: d.index, key: d.key, player: d.player })))
  assert.deepEqual(remaining, [{ index: 1, key: profiles.players[1], player: 1 }])
  await page.evaluate(() => { window.__pads.list[0] = window.__pads.wheel }); await wait(250)
  await tap('second', 13); assert.equal(await page.evaluate(() => window.__apex.paused), false)
  const restored = await page.evaluate(() => window.__apex.input.listDevices().map((d) => d.player))
  assert.deepEqual(restored, [0, 1])
  console.log('PASS both wheel pause controls resume, and unplug/replug of P1 preserves P2 identity')
  assert.deepEqual(pageErrors, [])
  console.log('Wheel integration passed with two synthetic identical G29 devices; physical macOS hardware remains unverified.')
} finally { await browser.close() }
