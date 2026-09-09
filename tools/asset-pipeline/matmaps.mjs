#!/usr/bin/env node
/**
 * Mini top-down maps of a model's largest materials, one per cell, in one PNG:
 * the fastest way to tell the track surface from walls, fences, grass and
 * paddocks in a ripped export whose material names mean nothing.
 * Usage: node tools/asset-pipeline/matmaps.mjs <scene.gltf> <out.png> [count=24] [cols=4] [--crop x0,z0,x1,z1]
 */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import sharp from 'sharp'
const argv = process.argv.slice(2)
const ci = argv.indexOf('--crop'); const crop = ci >= 0 ? argv.splice(ci, 2)[1].split(',').map(Number) : null
const [file, out, countArg, colsArg] = argv
const count = Number(countArg ?? 24), cols = Number(colsArg ?? 4)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(file)
const scene = doc.getRoot().listScenes()[0]
const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]
const mats = new Map()
scene.traverse((n) => {
  const mesh = n.getMesh(); if (!mesh) return
  const M = Array.from(n.getWorldMatrix())
  for (const p of mesh.listPrimitives()) {
    const name = p.getMaterial()?.getName() ?? '-'
    const e = mats.get(name) ?? mats.set(name, { name, tris: [] }).get(name)
    const pos = p.getAttribute('POSITION').getArray(), idx = p.getIndices()?.getArray()
    const n3 = idx ? idx.length : pos.length / 3
    for (let t = 0; t < n3; t += 3) { const tri = []; for (let k = 0; k < 3; k++) { const v = idx ? idx[t + k] : t + k; tri.push(xf(M, [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]])) } e.tris.push(tri) }
  }
})
const list = [...mats.values()].sort((a, b) => b.tris.length - a.tris.length).slice(0, count)
let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity]
if (crop) { lo = [crop[0], crop[1]]; hi = [crop[2], crop[3]] } else {
  // Bounds from the 5th-95th percentile of triangle centroids across all materials, so a giant backdrop does not shrink everything.
  const xs = [], zs = []
  for (const m of list) for (let i = 0; i < m.tris.length; i += Math.max(1, Math.floor(m.tris.length / 2000))) { const t = m.tris[i]; xs.push((t[0][0] + t[1][0] + t[2][0]) / 3); zs.push((t[0][1] + t[1][1] + t[2][1]) / 3) }
  xs.sort((a, b) => a - b); zs.sort((a, b) => a - b)
  const q = (a, f) => a[Math.floor(f * (a.length - 1))]
  lo = [q(xs, 0.03), q(zs, 0.03)]; hi = [q(xs, 0.97), q(zs, 0.97)]
}
const CW = 360, CH = 380, W = cols * CW, H = Math.ceil(list.length / cols) * CH
const S = Math.min((CW - 10) / (hi[0] - lo[0]), (CH - 30) / (hi[1] - lo[1]))
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#eef2ea"/>`
list.forEach((m, i) => {
  const ox = (i % cols) * CW + 5, oy = Math.floor(i / cols) * CH + 24
  const X = (x) => (ox + (x - lo[0]) * S).toFixed(1), Z = (z) => (oy + (z - lo[1]) * S).toFixed(1)
  svg += `<rect x="${ox}" y="${oy}" width="${CW - 10}" height="${CH - 30}" fill="#fff" stroke="#bbb"/>`
  svg += `<text x="${ox}" y="${oy - 7}" font-size="13" font-family="Helvetica, Arial">${m.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 30)}  ·  ${m.tris.length} tris</text>`
  svg += `<g fill="#333" stroke="#333" stroke-width="0.4">`
  const step = Math.max(1, Math.floor(m.tris.length / 40000))
  for (let k = 0; k < m.tris.length; k += step) { const t = m.tris[k]; svg += `<polygon points="${t.map((p) => X(p[0]) + ',' + Z(p[1])).join(' ')}"/>` }
  svg += '</g>'
})
svg += '</svg>'
await sharp(Buffer.from(svg)).png().toFile(out)
console.log(`${out}: ${list.length} materials, bounds x ${lo[0].toFixed(0)}..${hi[0].toFixed(0)} z ${lo[1].toFixed(0)}..${hi[1].toFixed(0)}`)
