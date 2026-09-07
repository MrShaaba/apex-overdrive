#!/usr/bin/env node
/**
 * Validates public/assets/manifest.json entries against the size/format budgets in
 * docs/ASSET_PIPELINE.md. Exits non-zero on violations so it can gate CI.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const root = new URL('../../public/assets/', import.meta.url).pathname
const manifestPath = join(root, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.log('No manifest found — nothing to validate (the game runs fully procedurally).')
  process.exit(0)
}
const budgets = {
  model: { max: 2 * 1024 * 1024, ext: ['.glb', '.gltf'] },
  texture: { max: 1024 * 1024, ext: ['.ktx2', '.webp', '.jpg', '.jpeg', '.png'] },
  audio: { max: 500 * 1024, ext: ['.ogg', '.mp3', '.webm', '.wav'] },
  data: { max: 2 * 1024 * 1024, ext: ['.json'] },
  // 2048×1024 RGBE panorama, RLE-compressed (see convert-hdri.mjs).
  hdri: { max: 8 * 1024 * 1024, ext: ['.hdr'] },
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
let errors = 0
for (const a of manifest.assets ?? []) {
  const b = budgets[a.type]
  const file = join(root, a.file)
  if (!b) { console.error(`✗ ${a.id}: unknown type ${a.type}`); errors++; continue }
  if (!existsSync(file)) { console.error(`✗ ${a.id}: missing file ${a.file}`); errors++; continue }
  const size = statSync(file).size
  if (!b.ext.includes(extname(a.file).toLowerCase())) { console.error(`✗ ${a.id}: ${extname(a.file)} not allowed for ${a.type}`); errors++ }
  if (size > b.max) { console.error(`✗ ${a.id}: ${(size / 1024).toFixed(0)} kB exceeds ${(b.max / 1024).toFixed(0)} kB`); errors++ }
  else console.log(`✓ ${a.id} (${(size / 1024).toFixed(0)} kB)`)
}
console.log(errors ? `${errors} problem(s)` : 'All assets within budget')
process.exit(errors ? 1 : 0)
