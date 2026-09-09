// materials whose triangles have centroids inside boxes: node boxmats.mjs scene.gltf x0,z0,x1,z1 ...
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
const [file, ...boxes] = process.argv.slice(2)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(file)
const scene = doc.getRoot().listScenes()[0]
const xf = (m, p) => [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12], m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]]
for (const b of boxes) {
  const [x0, z0, x1, z1] = b.split(',').map(Number)
  const acc = new Map()
  scene.traverse((n) => {
    const mesh = n.getMesh(); if (!mesh) return
    const M = Array.from(n.getWorldMatrix())
    for (const p of mesh.listPrimitives()) {
      const mat = p.getMaterial()?.getName() ?? ''
      const pos = p.getAttribute('POSITION').getArray(), idx = p.getIndices()?.getArray()
      const n3 = idx ? idx.length : pos.length / 3
      for (let t = 0; t < n3; t += 3) {
        let cx = 0, cy = 0, cz = 0, area = 0
        const P = []
        for (let k = 0; k < 3; k++) { const v = idx ? idx[t+k] : t+k; const q = xf(M, [pos[v*3], pos[v*3+1], pos[v*3+2]]); P.push(q); cx += q[0]/3; cy += q[1]/3; cz += q[2]/3 }
        if (cx < x0 || cx > x1 || cz < z0 || cz > z1) continue
        const ax = P[1][0]-P[0][0], az = P[1][2]-P[0][2], bx = P[2][0]-P[0][0], bz = P[2][2]-P[0][2]
        area = Math.abs(ax*bz - az*bx) / 2
        const e = acc.get(mat) ?? { n: 0, area: 0, ymin: Infinity, ymax: -Infinity, node: n.getName() }
        e.n++; e.area += area; e.ymin = Math.min(e.ymin, cy); e.ymax = Math.max(e.ymax, cy); acc.set(mat, e)
      }
    }
  })
  console.log(`box ${b}:`)
  for (const [m, e] of [...acc].sort((a, b2) => b2[1].area - a[1].area).slice(0, 14)) console.log(`  ${m.padEnd(22)} tris ${String(e.n).padStart(5)} area ${e.area.toFixed(0).padStart(7)} m²  y ${e.ymin.toFixed(1)}..${e.ymax.toFixed(1)}  ${e.node}`)
}
