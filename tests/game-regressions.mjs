import assert from 'node:assert/strict'
import fs from 'node:fs'
import { launchBrowser, harness, SERVER } from './support/browser.mjs'

const browser = await launchBrowser()
try {
  const modulePage = await harness(browser)
  const checks = await modulePage.evaluate(async () => {
    const { SaveManager, createDefaultProfile } = await import('/src/game/persistence/SaveManager.ts')
    const { MemoryStorageAdapter, LocalStorageAdapter } = await import('/src/game/persistence/StorageAdapter.ts')
    const { TRACK_CATALOG, TRACK_BY_ID } = await import('/src/game/tracks/TrackCatalog.ts')
    const { VEHICLE_CATALOG } = await import('/src/game/vehicles/VehicleCatalog.ts')
    const { registerContentPack } = await import('/src/game/content/ContentRegistry.ts')
    const defaults = createDefaultProfile()
    const freshUnlocks = TRACK_CATALOG.every(t => t.unlockLevel > 1 || defaults.unlockedTracks.includes(t.id))
    const manager = new SaveManager(new MemoryStorageAdapter())
    await manager.load()
    const track = { ...TRACK_CATALOG[0], id: 'regression-track', unlockLevel: 1 }
    registerContentPack({ id: 'regression-pack', tracks: [track] })
    const extensionUnlocked = manager.get().unlockedTracks.includes(track.id) && TRACK_BY_ID[track.id] === track
    const beforeCount = TRACK_CATALOG.length
    let rejected = false
    try { registerContentPack({ id: 'bad-pack', tracks: [{ ...track, id: 'must-not-install' }, track] }) } catch { rejected = true }
    const atomic = rejected && TRACK_CATALOG.length === beforeCount && !TRACK_BY_ID['must-not-install']
    const imported = await manager.importJson(JSON.stringify({ version: 1, ownedCars: ['dodge-charger'], settings: { controls: { transmission: 'manual' } } }))
    const importedDefaults = imported && manager.get().settings.controls.transmission === 'manual' && Array.isArray(manager.get().settings.controls.pedals) && !!manager.get().settings.graphics
    const badImport = !(await manager.importJson('{"ownedCars":"not-an-array"}'))
    const storage = new LocalStorageAdapter()
    await storage.write('quota-test', { sequence: 1 })
    const original = Storage.prototype.setItem
    try {
      Storage.prototype.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError') }
      await storage.write('quota-test', { sequence: 2 })
    } finally { Storage.prototype.setItem = original }
    const fallback = (await storage.read('quota-test')).sequence === 2
    await storage.remove('quota-test')
    return { freshUnlocks, extensionUnlocked, atomic, importedDefaults, badImport, fallback,
      assets: [...TRACK_CATALOG.filter(t => t.id !== track.id).map(t => t.model?.file), ...VEHICLE_CATALOG.map(v => v.model?.file)].filter(Boolean) }
  })
  for (const [name, value] of Object.entries(checks)) if (name !== 'assets') { assert.equal(value, true, name); console.log(`PASS ${name}`) }
  for (const asset of checks.assets) assert.ok(fs.existsSync(`public/${asset}`), `Missing catalog asset: ${asset}`)
  await modulePage.close()

  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const errors = []
  const clickButton = async (label, selector = 'button') => {
    await page.waitForFunction((label, selector) => [...document.querySelectorAll(selector)].some(button => button.textContent.includes(label)), {}, label, selector)
    for (const button of await page.$$(selector)) {
      if ((await button.evaluate(el => el.textContent)).includes(label)) { await button.click(); return }
    }
    throw new Error(`Missing button: ${label}`)
  }
  page.on('pageerror', error => errors.push(error.message))
  await page.evaluateOnNewDocument(() => {
    window.__pad = { index: 0, id: 'Regression Xbox Controller', connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }
    navigator.getGamepads = () => [window.__pad]
  })
  await page.goto(SERVER)
  await page.waitForFunction(() => window.__apex?.mode === 'showcase', { timeout: 60000 })
  assert.equal(await page.evaluate(() => window.__apex.physics === undefined), true, 'Physics should load on first race, not in menu')
  fs.mkdirSync('tests/shots', { recursive: true })
  await new Promise(resolve => setTimeout(resolve, 1500))
  await page.screenshot({ path: 'tests/shots/main-menu-v2.png' })
  const start = (mode = 'freeroam') => page.evaluate(mode => window.__apex.startRace({ mode, trackId: 'sepang', carId: 'mercedes-w13', laps: 1, aiCount: 0, aiMix: 'pro', difficulty: 'pro', weather: 'clear', hour: 12, dynamicWeather: false, timeRate: 0, ghost: false, seed: 1 }), mode)
  const button = async (index, on) => page.evaluate((index, on) => { window.__pad.buttons[index] = { pressed: on, value: on ? 1 : 0 } }, index, on)
  const tapPause = async () => {
    await button(9, true); await new Promise(r => setTimeout(r, 150))
    await button(9, false); await new Promise(r => setTimeout(r, 150))
  }
  await start()
  await tapPause()
  assert.equal(await page.evaluate(() => window.__apex.paused), true, 'pad pauses')
  await tapPause()
  assert.equal(await page.evaluate(() => window.__apex.paused), false, 'pad resumes while driving input is disabled')
  await tapPause()
  await page.evaluate(() => window.__apex.quitToMenu())
  const colliders = await page.evaluate(() => window.__apex.physics.world.colliders.len())
  assert.equal(colliders, 0, 'exiting a race must remove every collider')
  await start()
  await button(7, true)
  await page.waitForFunction(() => window.__apex.player.telemetry.speedKmh > 25, { timeout: 15000 })
  await button(7, false)
  await page.screenshot({ path: 'tests/shots/driving-v2.png' })
  // Disconnect at speed; game must pause rather than silently hand off to another pad.
  await page.evaluate(() => { navigator.getGamepads = () => [] })
  await page.waitForFunction(() => window.__apex.paused, { timeout: 5000 })
  await page.evaluate(() => window.__apex.quitToMenu())
  await start('quick')
  await page.waitForFunction(() => window.__apex.race.phase === 'racing', { timeout: 15000 })
  await page.keyboard.down('w')
  await page.waitForFunction(() => window.__apex.replay.frameCount > 30, { timeout: 15000 })
  await page.keyboard.up('w')
  await page.keyboard.press('f')
  await page.waitForSelector('.photo-ui')
  await clickButton('Capture')
  await page.waitForFunction(() => document.querySelector('.photo-ui')?.textContent.includes('Download last'))
  const photo = await page.evaluate(async () => (await import('/src/game/persistence/SaveManager.ts')).saveManager.get().photos[0])
  assert.ok(photo.startsWith('data:image/'), 'photo capture saved in gallery')
  await clickButton('Exit', '.photo-ui button')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => window.__apex.paused)
  await clickButton('Retire from session')
  await page.waitForFunction(() => document.querySelector('.screen__title')?.textContent === 'Race results')
  await clickButton('Replay')
  await page.waitForSelector('.replay-bar')
  assert.equal(await page.evaluate(() => window.__apex.mode), 'replay')
  await clickButton('Exit', '.replay-bar button')
  await page.waitForFunction(() => document.querySelector('.screen__title')?.textContent === 'Race results')
  await page.evaluate(() => window.__apex.quitToMenu())
  console.log('PASS photo capture, retirement/results, replay controls and return to results')
  assert.deepEqual(errors, [], 'uncaught errors during session lifecycle')
  console.log('PASS deferred physics, controller pause/resume, paused exit/restart, disconnect pause, collider disposal, runtime assets')
} finally { await browser.close() }
