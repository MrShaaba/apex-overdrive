// Ground-surface census of a circuit export: per material, total area, the share of it
// that is flat (|normal.y| > 0.9), height range and the class prepare-track's rules give it.
// Big flat areas that land in 'prop' are drivable surfaces without a collider.
// Usage: node tools/asset-pipeline/flatmats.mjs <scene.gltf> [minFlatArea=500]
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
const [file, minArea = '500'] = process.argv.slice(2)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(file)
const scene = doc.getRoot().listScenes()[0]
const xf = (m, p) => [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12], m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]]
const acc = new Map()
scene.traverse((n) => {
  const mesh = n.getMesh(); if (!mesh) return
  const M = Array.from(n.getWorldMatrix())
  for (const p of mesh.listPrimitives()) {
    const mat = p.getMaterial()?.getName() ?? ''
    const pos = p.getAttribute('POSITION').getArray(), idx = p.getIndices()?.getArray()
    const n3 = idx ? idx.length : pos.length / 3
    const e = acc.get(mat) ?? { n: 0, area: 0, flat: 0, ymin: Infinity, ymax: -Infinity, node: n.getName(), xmin: Infinity, xmax: -Infinity, zmin: Infinity, zmax: -Infinity }
    for (let t = 0; t < n3; t += 3) {
      const P = []
      for (let k = 0; k < 3; k++) { const v = idx ? idx[t+k] : t+k; P.push(xf(M, [pos[v*3], pos[v*3+1], pos[v*3+2]])) }
      const ax = P[1][0]-P[0][0], ay = P[1][1]-P[0][1], az = P[1][2]-P[0][2], bx = P[2][0]-P[0][0], by = P[2][1]-P[0][1], bz = P[2][2]-P[0][2]
      const nx = ay*bz - az*by, ny = az*bx - ax*bz, nz = ax*by - ay*bx
      const a2 = Math.hypot(nx, ny, nz), area = a2 / 2
      if (!(area > 0)) continue
      e.n++; e.area += area; if (Math.abs(ny / a2) > 0.9) e.flat += area
      for (const q of P) { e.ymin = Math.min(e.ymin, q[1]); e.ymax = Math.max(e.ymax, q[1]); e.xmin = Math.min(e.xmin, q[0]); e.xmax = Math.max(e.xmax, q[0]); e.zmin = Math.min(e.zmin, q[2]); e.zmax = Math.max(e.zmax, q[2]) }
    }
    acc.set(mat, e)
  }
})
const rows = [...acc].filter(([, e]) => e.flat >= Number(minArea)).sort((a, b) => b[1].flat - a[1].flat)
console.log('material               flat m²   total m²  flat%  y range           x range           z range           tris')
for (const [m, e] of rows) console.log(`${m.padEnd(22)} ${e.flat.toFixed(0).padStart(8)} ${e.area.toFixed(0).padStart(10)}  ${(100*e.flat/e.area).toFixed(0).padStart(4)}  ${e.ymin.toFixed(1).padStart(6)}..${e.ymax.toFixed(1).padEnd(7)}  ${e.xmin.toFixed(0).padStart(6)}..${e.xmax.toFixed(0).padEnd(6)}  ${e.zmin.toFixed(0).padStart(6)}..${e.zmax.toFixed(0).padEnd(6)}  ${e.n}`)
