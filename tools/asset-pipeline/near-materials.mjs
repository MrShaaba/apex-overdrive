#!/usr/bin/env node
/**
 * Which materials have triangles near a world position — for finding what a
 * circuit model uses at a spot the tracer reports (a ring gap, a crash site).
 * Usage: node tools/asset-pipeline/near-materials.mjs <scene.gltf> x,z [x,z ...]
 */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
const [file, ...pts] = process.argv.slice(2)
const targets = pts.map((s) => s.split(',').map(Number))
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(file)
const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]
const counts = targets.map(() => new Map())
doc.getRoot().listScenes()[0].traverse((n) => {
  const mesh = n.getMesh(); if (!mesh) return
  const M = Array.from(n.getWorldMatrix())
  for (const p of mesh.listPrimitives()) {
    const mat = p.getMaterial()?.getName() ?? '-'
    const pos = p.getAttribute('POSITION').getArray(), idx = p.getIndices()?.getArray()
    const n3 = idx ? idx.length : pos.length / 3
    for (let t = 0; t < n3; t += 3) {
      let cx = 0, cz = 0, cy = 0
      for (let k = 0; k < 3; k++) { const i = idx ? idx[t + k] : t + k; const w = xf(M, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]); cx += w[0] / 3; cy += w[1] / 3; cz += w[2] / 3 }
      targets.forEach((tg, k) => { if (Math.hypot(cx - tg[0], cz - tg[1]) < 12) { const c = counts[k].get(mat) ?? { n: 0, y: cy }; c.n++; counts[k].set(mat, c) } })
    }
  }
})
targets.forEach((tg, k) => console.log(`near (${tg}): ` + [...counts[k].entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 9).map(([m, c]) => `${m.replace(/\.002$/, '')}×${c.n}@y${c.y.toFixed(0)}`).join('  ')))
