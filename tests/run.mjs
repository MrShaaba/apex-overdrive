import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { chromePath } from './support/browser.mjs'

const suites = ['physics-regressions', 'hazard-regressions', 'controller-regressions', 'ai-regressions', 'mode-regressions', 'game-regressions', 'ui-flow', 'driving-audit', 'road-surface-regressions', 'collider-audit', 'wheel-calibration', 'split-screen', 'billboards']
const selected = process.argv.slice(2)
for (const name of selected) if (!suites.includes(name)) throw new Error(`Unknown suite ${name}. Choose: ${suites.join(', ')}`)
const chrome = chromePath()
let server
let url = process.env.APEX_URL
try {
  if (!url) {
    server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, clearScreen: false })
    await server.listen()
    const address = server.httpServer.address()
    url = `http://127.0.0.1:${address.port}/`
  } else {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`APEX_URL returned HTTP ${response.status}`)
  }
  for (const suite of selected.length ? selected : suites) {
    console.log(`\n▶ ${suite}`)
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [`tests/${suite}.mjs`], { stdio: 'inherit', env: { ...process.env, APEX_URL: url, CHROME: chrome } })
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`${suite} timed out after 15 minutes`)) }, 900000)
      child.on('error', reject)
      child.on('exit', code => { clearTimeout(timeout); resolve(code) })
    })
    if (code !== 0) throw new Error(`${suite} failed (exit ${code})`)
  }
  console.log('\nAll selected suites passed.')
} finally { await server?.close() }
