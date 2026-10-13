import assert from 'node:assert/strict'
import fs from 'node:fs'
import { preview } from 'vite'
import { launchBrowser } from './support/browser.mjs'

const server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: false, open: false } })
const browser = await launchBrowser()
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  const requests = [], errors = [], failures = []
  page.on('request', request => requests.push(request.url()))
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`) })
  const clickText = async (selector, label) => {
    await page.waitForFunction((selector, label) => [...document.querySelectorAll(selector)].some(el => el.textContent.includes(label)), {}, selector, label)
    for (const element of await page.$$(selector)) {
      if ((await element.evaluate(el => el.textContent)).includes(label)) { await element.click(); return }
    }
    throw new Error(`Missing ${label}`)
  }
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`)
  await page.waitForSelector('.menu__nav', { timeout: 60000 })
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(requests.some(url => /rapier-.*\.js/.test(url)), false, 'physics is not downloaded for the production menu')
  assert.equal(await page.evaluate(() => '__apex' in window), false, 'production does not expose the debug engine')
  await clickText('.menu__nav button', 'Race')
  await clickText('.card', 'Open Driving')
  await clickText('.circuit-card', 'Fam Jam')
  await page.select('select[aria-label="Player 1 car"]', 'mercedes-w13')
  await clickText('button', 'Start')
  await page.waitForSelector('.speedo__speed', { timeout: 120000 })
  await page.keyboard.down('w')
  await page.waitForFunction(() => Number(document.querySelector('.speedo__speed')?.textContent) > 30, { timeout: 20000 })
  await page.keyboard.up('w')
  assert.equal(requests.some(url => /rapier-.*\.js/.test(url)), true, 'first race loads the physics chunk')
  assert.equal(requests.some(url => /photos\/fam-jam\/.+\.jpg/.test(url)), true, 'production loads local family pictures')
  fs.mkdirSync('tests/shots', { recursive: true })
  await page.screenshot({ path: 'tests/shots/production-race.png' })
  await page.keyboard.press('Escape')
  await clickText('button', 'Quit to menu')
  await page.waitForSelector('.menu__nav')
  assert.deepEqual(errors, [], 'production runtime errors')
  assert.deepEqual(failures, [], 'missing production assets')
  console.log('PASS production build: deferred physics, Fam Jam photos, W13 keyboard driving, pause/exit; no runtime or asset errors')
} finally {
  await browser.close()
  await new Promise(resolve => server.httpServer.close(resolve))
}
