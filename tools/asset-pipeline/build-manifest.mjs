#!/usr/bin/env node
/**
 * Scans public/assets/{models,textures,audio,data} and writes public/assets/manifest.json.
 * Ids are derived from the relative path: textures/road/asphalt.ktx2 → texture.road.asphalt
 */
import { readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative, extname, sep } from 'node:path'

const root = new URL('../../public/assets/', import.meta.url).pathname
const types = { models: 'model', textures: 'texture', audio: 'audio', data: 'data', hdri: 'hdri' }
const assets = []

function walk(dir, type) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, type)
    else if (!entry.startsWith('.') && entry !== 'manifest.json' && !/\.(txt|md)$/i.test(entry)) {
      const rel = relative(root, full).split(sep).join('/')
      const id = `${type}.${rel.split('/').slice(1).join('.').replace(extname(rel), '')}`
      assets.push({ id, type, file: rel, bytes: st.size })
    }
  }
}

for (const [folder, type] of Object.entries(types)) walk(join(root, folder), type)
const manifest = { version: 1, generatedAt: new Date().toISOString(), assets }
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Wrote manifest with ${assets.length} asset(s) → public/assets/manifest.json`)
