import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import puppeteer from 'puppeteer-core'

export const SERVER = process.env.APEX_URL ?? 'http://127.0.0.1:5180/'

export function chromePath() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    `${process.env.PROGRAMFILES}/Google/Chrome/Application/chrome.exe`,
    `${process.env['PROGRAMFILES(X86)']}/Google/Chrome/Application/chrome.exe`,
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  ]
  for (const file of candidates) if (fs.existsSync(file)) return file
  for (const command of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8' }).trim().split('\n')[0] } catch { /* try next */ }
  }
  throw new Error('Chrome/Chromium was not found. Install it or set CHROME to its executable path, then run npm test.')
}

export const launchBrowser = () => puppeteer.launch({
  executablePath: chromePath(), headless: true,
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--window-size=1280,720'],
  protocolTimeout: 300000,
})

export async function harness(browser) {
  const page = await browser.newPage()
  await page.goto(new URL('tests/harness.html', SERVER).href)
  return page
}
