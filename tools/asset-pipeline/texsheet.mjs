#!/usr/bin/env node
/**
 * Contact sheet of a model's materials: each cell shows the base-colour texture
 * with the material name, triangle count and world extent (x × y × z), sorted
 * by triangle count. For ripped circuit exports whose material names carry no
 * meaning, this is how a prepare-track config gets written.
 * Usage: node tools/asset-pipeline/texsheet.mjs <scene.gltf> <out.png> [minTris] [cols]
 */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import sharp from 'sharp'
const [file, out, minArg, colsArg] = process.argv.slice(2)
const minTris = Number(minArg ?? 100), cols = Number(colsArg ?? 6)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(file)
const scene = doc.getRoot().listScenes()[0]
const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]
const rows = new Map()
scene.traverse((n) => {
  const mesh = n.getMesh(); if (!mesh) return
  const M = Array.from(n.getWorldMatrix())
  for (const p of mesh.listPrimitives()) {
    const mat = p.getMaterial(); if (!mat) continue
    const r = rows.get(mat) ?? rows.set(mat, { mat, tris: 0, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] }).get(mat)
    r.tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3
    const pos = p.getAttribute('POSITION'), mn = pos.getMin([]), mx = pos.getMax([])
    for (const cx of [mn[0], mx[0]]) for (const cy of [mn[1], mx[1]]) for (const cz of [mn[2], mx[2]]) { const q = xf(M, [cx, cy, cz]); for (let i = 0; i < 3; i++) { r.lo[i] = Math.min(r.lo[i], q[i]); r.hi[i] = Math.max(r.hi[i], q[i]) } }
  }
})
const list = [...rows.values()].filter((r) => r.tris >= minTris).sort((a, b) => b.tris - a.tris)
const T = 144, CW = 232, CH = T + 52, W = cols * CW, H = Math.ceil(list.length / cols) * CH
const composites = []
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#222"/>`
for (let i = 0; i < list.length; i++) {
  const r = list[i], x = (i % cols) * CW + 8, y = Math.floor(i / cols) * CH + 4
  const tex = r.mat.getBaseColorTexture()
  if (tex) {
    try {
      const buf = await sharp(Buffer.from(tex.getImage())).resize(T, T, { fit: 'inside' }).png().toBuffer()
      composites.push({ input: buf, left: x, top: y })
    } catch { /* unreadable image: leave the cell blank */ }
  } else {
    const c = r.mat.getBaseColorFactor().slice(0, 3).map((v) => Math.round(Math.pow(v, 1 / 2.2) * 255))
    svg += `<rect x="${x}" y="${y}" width="${T}" height="${T}" fill="rgb(${c.join(',')})"/>`
  }
  const size = r.hi.map((v, k) => v - r.lo[k]).map((v) => v.toFixed(0))
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  svg += `<text x="${x}" y="${y + T + 16}" font-size="13" font-family="Helvetica, Arial" fill="#fff">${esc(r.mat.getName().slice(0, 26))}${r.mat.getAlphaMode() === 'BLEND' ? ' (blend)' : ''}</text>`
  svg += `<text x="${x}" y="${y + T + 32}" font-size="12" font-family="Helvetica, Arial" fill="#9cf">${Math.round(r.tris)} tris  ${size.join('×')} m  y ${r.lo[1].toFixed(0)}..${r.hi[1].toFixed(0)}</text>`
}
svg += '</svg>'
await sharp(Buffer.from(svg)).composite(composites).png().toFile(out)
console.log(`${out}: ${list.length} materials with ≥ ${minTris} tris (${rows.size} total), ${W}×${H}`)
