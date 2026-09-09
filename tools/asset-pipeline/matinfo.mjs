#!/usr/bin/env node
/**
 * Material table for a circuit model: name, base-colour texture file, triangle
 * count over all primitives using it, and the world bounds of that geometry —
 * the basis for prepare-track rules when material names are meaningless
 * (`Merged_materials`, `11001Mtl_76`) and only the texture says what a surface is.
 * Usage: node tools/asset-pipeline/matinfo.mjs <scene.gltf> [minTris]
 */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
const [file, minArg] = process.argv.slice(2)
const minTris = Number(minArg ?? 0)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(file)
const scene = doc.getRoot().listScenes()[0]
const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]
const rows = new Map()
scene.traverse((n) => {
  const mesh = n.getMesh(); if (!mesh) return
  const M = Array.from(n.getWorldMatrix())
  for (const p of mesh.listPrimitives()) {
    const mat = p.getMaterial()
    const name = mat?.getName() ?? '-'
    const tex = mat?.getBaseColorTexture()
    const uri = tex ? (tex.getURI() || tex.getName() || `(embedded ${tex.getMimeType()})`).replace(/^textures\//, '') : '-'
    const key = `${name}|${uri}`
    const r = rows.get(key) ?? rows.set(key, { name, uri, tris: 0, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], nodes: new Set(), ds: mat?.getDoubleSided(), alpha: mat?.getAlphaMode() }).get(key)
    r.tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3
    r.nodes.add(n.getName())
    const pos = p.getAttribute('POSITION')
    const mn = pos.getMin([]), mx = pos.getMax([])
    for (const cx of [mn[0], mx[0]]) for (const cy of [mn[1], mx[1]]) for (const cz of [mn[2], mx[2]]) { const q = xf(M, [cx, cy, cz]); for (let i = 0; i < 3; i++) { r.lo[i] = Math.min(r.lo[i], q[i]); r.hi[i] = Math.max(r.hi[i], q[i]) } }
  }
})
const list = [...rows.values()].filter((r) => r.tris >= minTris).sort((a, b) => b.tris - a.tris)
console.log(`# ${file}: ${rows.size} material/texture pairs (${list.length} with ≥ ${minTris} tris)`)
for (const r of list) {
  const size = r.hi.map((v, i) => v - r.lo[i])
  console.log(`${r.name.padEnd(26).slice(0, 26)} ${r.uri.padEnd(34).slice(0, 34)} ${String(Math.round(r.tris)).padStart(7)}  ${size.map((v) => v.toFixed(0).padStart(5)).join('×')}  y ${r.lo[1].toFixed(0)}..${r.hi[1].toFixed(0)}  ${r.alpha}${r.ds ? ' 2s' : ''}  ${[...r.nodes].slice(0, 3).join(',')}${r.nodes.size > 3 ? ` +${r.nodes.size - 3}` : ''}`)
}
