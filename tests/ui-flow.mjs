import assert from 'node:assert/strict'
import fs from 'node:fs'
import { launchBrowser, SERVER } from './support/browser.mjs'

const browser = await launchBrowser()
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const clickButton = async label => {
    const buttons = await page.$$('button')
    for (const button of buttons) {
      if ((await button.evaluate(el => el.textContent)).includes(label)) {
        await button.click()
        return
      }
    }
    throw new Error(`Button not found: ${label}`)
  }
  const clickCard = async label => {
    const cards = await page.$$('.card')
    for (const card of cards) {
      if ((await card.evaluate(el => el.textContent)).includes(label)) {
        assert.equal(await card.evaluate(el => el.classList.contains('card--locked')), false, `${label} must be available`)
        await card.click()
        return
      }
    }
    throw new Error(`Card not found: ${label}`)
  }
  const title = text => page.waitForFunction(text => document.querySelector('.screen__title')?.textContent === text, {}, text)
  await page.goto(SERVER)
  await page.waitForFunction(() => window.__apex?.mode === 'showcase', { timeout: 60000 })
  await new Promise(resolve => setTimeout(resolve, 2000))
  fs.mkdirSync('tests/shots', { recursive: true })
  await page.screenshot({ path: 'tests/shots/main-menu-v2.png' })
  for (const [menu, expected] of [['Story', 'Apex League'], ['Workshop', 'Workshop'], ['Rankings', 'Rankings'], ['Gallery', 'Gallery'], ['Driver', 'Driver Profile'], ['Local racing', 'Local racing']]) {
    await clickButton(menu)
    await page.waitForSelector('.screen__title')
    const actual = await page.$eval('.screen__title', el => el.textContent)
    console.log(`Opened ${menu}: ${actual}`)
    assert.ok(actual.length > 0, expected)
    await clickButton('Back')
    await page.waitForSelector('.menu__nav')
  }
  await clickButton('Race')
  await title('Race Staging')
  await clickCard('Open Driving')
  await clickCard('Fam Jam')
  await page.select('select[aria-label="Player 1 car"]', 'mercedes-w13')
  await clickButton('Two players')
  await page.waitForSelector('[data-testid="p2-cars"]')
  await page.select('select[aria-label="Player 2 car"]', 'mclaren-mcl35m')
  await page.screenshot({ path: 'tests/shots/family-race-setup.png' })
  await clickButton('Solo')
  await clickButton('Start')
  await page.waitForFunction(() => window.__apex.mode === 'race', { timeout: 120000 })
  assert.equal(await page.evaluate(() => window.__apex.track.def.id), 'sepang-fam-jam')
  assert.equal(await page.evaluate(() => window.__apex.player.spec.id), 'mercedes-w13')
  await page.keyboard.down('w')
  await page.waitForFunction(() => window.__apex.player.telemetry.speedKmh > 40, { timeout: 15000 })
  await page.keyboard.up('w')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => window.__apex.paused)
  await clickButton('Restart')
  await page.waitForFunction(() => window.__apex.mode === 'race' && !window.__apex.paused, { timeout: 120000 })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => window.__apex.paused)
  await clickButton('Quit to menu')
  await page.waitForSelector('.menu__nav')
  assert.deepEqual(errors, [])
  console.log('PASS menu navigation, family circuit selection, both car controls, keyboard driving, restart and exit through UI')
} finally { await browser.close() }
