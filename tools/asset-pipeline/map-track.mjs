#!/usr/bin/env node
/**
 * Top-down map of a circuit model for writing prepare-track configs: draws the
 * triangles of chosen material groups (label=regex, matched against material
 * names) and, optionally, a generated centreline with direction arrows,
 * distance labels and a ring on the start point.
 *
 * Usage: node tools/asset-pipeline/map-track.mjs <scene.gltf> <out.png> [--points src/game/tracks/data/<id>.points.json]
 *          [--crop x0,z0,x1,z1] [--width 1600] road='^asph' kerb='^kerb' pit='pitlane' ...
 * Colours: road/asph dark grey, kerb red, pit blue, runoff/carpet green, wall black, other labels by hash.
 */
import fs from 'node:fs'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import sharp from 'sharp'

const argv = process.argv.slice(2)
const opt = (name, def) => { const i = argv.indexOf(name); if (i < 0) return def; const v = argv[i + 1]; argv.splice(i, 2); return v }
const pointsFile = opt('--points', null)
const crop = opt('--crop', null)?.split(',').map(Number)
const W = Number(opt('--width', 1600))
const [file, out, ...groups] = argv
if (!file || !out) { console.error('usage: map-track.mjs <scene.gltf> <out.png> [--points file] [--crop x0,z0,x1,z1] label=regex ...'); process.exit(2) }

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(file)
const scene = doc.getRoot().listScenes()[0]
const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]
const layers = groups.map((g) => { const [label, re] = g.split('='); return { label, re: new RegExp(re), tris: [] } })
scene.traverse((n) => {
  const mesh = n.getMesh()
  if (!mesh) return
  const M = Array.from(n.getWorldMatrix())
  for (const p of mesh.listPrimitives()) {
    const mat = p.getMaterial()?.getName() ?? ''
    const layer = layers.find((l) => l.re.test(mat))
    if (!layer) continue
    const pos = p.getAttribute('POSITION').getArray(), idx = p.getIndices()?.getArray()
    const n3 = idx ? idx.length : pos.length / 3
    for (let t = 0; t < n3; t += 3) {
      const tri = []
      for (let k = 0; k < 3; k++) { const v = idx ? idx[t + k] : t + k; tri.push(xf(M, [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]])) }
      layer.tris.push(tri)
    }
  }
})
const pts = pointsFile ? JSON.parse(fs.readFileSync(pointsFile, 'utf8')).points : null

const palette = { road: '#444', asph: '#666', groove: '#333', kerb: '#d33', curb: '#d33', pit: '#39f', runoff: '#3c9', carpet: '#3c9', gravel: '#dc8', sand: '#dc8', wall: '#000', grass: '#9c6', terrain: '#9c6', overlay: '#aaa', prop: '#fa0' }
const hashColor = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 70% 45%)` }
let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity]
for (const l of layers) for (const t of l.tris) for (const p of t) { lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])] }
if (pts) for (const p of pts) { lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[2])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[2])] }
if (crop) { lo = [crop[0], crop[1]]; hi = [crop[2], crop[3]] }
const S = W / (hi[0] - lo[0]), H = Math.ceil((hi[1] - lo[1]) * S)
const X = (x) => ((x - lo[0]) * S).toFixed(1), Z = (z) => ((z - lo[1]) * S).toFixed(1)
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#e8f0e0"/>`
for (const l of layers) {
  const c = palette[l.label] ?? hashColor(l.label)
  svg += `<g fill="${c}" stroke="${c}" stroke-width="0.3">`
  for (const t of l.tris) svg += `<polygon points="${t.map((p) => X(p[0]) + ',' + Z(p[1])).join(' ')}"/>`
  svg += '</g>'
}
if (pts) {
  const spacing = pts.length > 1 ? Math.hypot(pts[1][0] - pts[0][0], pts[1][2] - pts[0][2]) : 16
  svg += `<polyline fill="none" stroke="#ff0" stroke-width="2" points="${pts.map((p) => X(p[0]) + ',' + Z(p[2])).join(' ')} ${X(pts[0][0])},${Z(pts[0][2])}"/>`
  const every = Math.max(1, Math.round(400 / spacing))
  for (let i = 0; i < pts.length; i += every) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    const dx = b[0] - a[0], dz = b[2] - a[2], n = Math.hypot(dx, dz) || 1, ux = dx / n, uz = dz / n
    const len = 12 / S, wid = 5 / S
    svg += `<polygon fill="#f00" points="${X(a[0] + ux * len)},${Z(a[2] + uz * len)} ${X(a[0] - uz * wid)},${Z(a[2] + ux * wid)} ${X(a[0] + uz * wid)},${Z(a[2] - ux * wid)}"/>`
    svg += `<text x="${X(a[0])}" y="${Z(a[2])}" font-size="16" fill="#00c">${Math.round(i * spacing)}</text>`
  }
  svg += `<circle cx="${X(pts[0][0])}" cy="${Z(pts[0][2])}" r="10" fill="none" stroke="#f00" stroke-width="3"/>`
}
svg += `<text x="10" y="26" font-size="20" fill="#000">x ${lo[0].toFixed(0)}..${hi[0].toFixed(0)}  z ${lo[1].toFixed(0)}..${hi[1].toFixed(0)}  (+x right, +z down; yellow = centreline, red arrows = direction)</text></svg>`
await sharp(Buffer.from(svg)).png().toFile(out)
console.log(`${out}: ${W}×${H}, ${layers.map((l) => `${l.label} ${l.tris.length} tris`).join(', ')}${pts ? `, ${pts.length} centreline points` : ''}`)
