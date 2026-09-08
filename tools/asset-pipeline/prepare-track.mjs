#!/usr/bin/env node
/**
 * Turns a raw Sketchfab circuit (assets-src/models/tracks/<name>/scene.gltf)
 * into a game-ready .glb under public/assets/models/tracks and derives the
 * lap centreline the game's TrackSpline needs.
 *
 *  1. bakes every node transform (plus scale/yaw) into the vertices and
 *     classifies meshes by the car's `rules` (regex on node path / material)
 *     into road / terrain / wall / prop, joining primitives per material;
 *  2. derives the centreline from the road mesh alone: welds the mesh, finds
 *     its boundary loops (the longest is the outer edge, the others are
 *     islands), walks the outer edge taking the midpoint to the nearest
 *     island edge, collapses cul-de-sac spurs (where the midline doubles
 *     back on itself), smooths, resamples and simplifies to control points
 *     for a closed Catmull-Rom spline. Nothing is authored by hand; a road
 *     without exactly one outer loop and ≥1 island aborts;
 *  3. orients the loop so the car drives +Z along the easternmost stretch,
 *     starts the lap in the middle of the longest straight, and reports
 *     length, the road width profile along the line and the overall bounds;
 *  4. encodes textures to KTX2 and Draco-compresses the geometry.
 *
 * Usage: node tools/asset-pipeline/prepare-track.mjs <track-id> [--skip-textures] [--map]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions'
import { dedup, draco, joinPrimitives, listTextureSlots, prune, simplify, textureCompress, transformPrimitive, weld } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'

const TRACKS = {
  drift: {
    source: 'assets-src/models/tracks/drift_race_track/scene.gltf',
    output: 'public/assets/models/tracks/drift.glb',
    credit: 'Drift Race Track Free by Nicholas-3D (sketchfab.com/Nicholas01), CC-BY-ND 4.0',
    scale: 1,
    yawDeg: 0,
    rules: [
      { cls: 'road', path: /\/Road/ },
      { cls: 'terrain', path: /\/Terrain/ },
      { cls: 'wall', path: /\/Barrier|\/Rails/ }, // Barrier, BarrierCylinder and the guard rails all stop cars
      // everything else (cones, arrows, flags, banners, bushes) is scenery
    ],
    decimate: { wall: 0.35 }, // the guard rails alone are 190k tris
    // Foliage cards ship as opaque; cut them out so the leaf edges are not white quads.
    materials: [{ match: /Leaf/i, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true }],
    textures: { color: 2048, normal: 1024, other: 1024 },
    controlSpacing: 14, // metres between spline control points
    pointsOut: 'src/game/tracks/data/drift.points.json', // imported by TrackCatalog
  },
}

const [trackId, ...flags] = process.argv.slice(2)
const cfg = TRACKS[trackId]
if (!cfg) {
  console.error(`unknown track "${trackId}". Known: ${Object.keys(TRACKS).join(', ')}`)
  process.exit(2)
}
const skipTextures = flags.includes('--skip-textures')
const t0 = Date.now()

// --- helpers ---------------------------------------------------------------------
const mul = (a, b) => { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o }
const scaleM = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]
const yawM = (rad) => [Math.cos(rad), 0, -Math.sin(rad), 0, 0, 1, 0, 0, Math.sin(rad), 0, Math.cos(rad), 0, 0, 0, 0, 1]
const fmt = (v) => v.map((x) => x.toFixed(2)).join(', ')

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.encoder': await draco3d.createEncoderModule() })
const doc = await io.read(cfg.source)
const root = doc.getRoot()
const scene = root.listScenes()[0]
const buffer = root.listBuffers()[0]

// --- collect + bake --------------------------------------------------------------
const prims = []
function walk(node, parentPath) {
  const pathStr = `${parentPath}/${node.getName()}`
  const mesh = node.getMesh()
  if (mesh) {
    const world = Array.from(node.getWorldMatrix())
    for (const prim of mesh.listPrimitives()) {
      const matName = prim.getMaterial()?.getName() ?? ''
      const rule = cfg.rules.find((r) => (r.path && r.path.test(pathStr)) || (r.material && r.material.test(matName)))
      prims.push({ prim, cls: rule ? rule.cls : 'prop', pathStr, matName, world })
    }
  }
  for (const c of node.listChildren()) walk(c, pathStr)
}
for (const c of scene.listChildren()) walk(c, '')
const R = mul(yawM((cfg.yawDeg * Math.PI) / 180), scaleM(cfg.scale))
for (const p of prims) transformPrimitive(p.prim, mul(R, p.world))
const counts = {}
for (const p of prims) counts[p.cls] = (counts[p.cls] || 0) + 1
console.log('primitives by class:', JSON.stringify(counts))

// --- centreline from the road mesh ------------------------------------------------
// The road surface is rasterised at 1 m, thinned to a one-pixel skeleton
// (Zhang–Suen), stripped of short spurs, and then walked with the right-hand
// rule from its westernmost pixel: keeping the outside of the circuit on the
// right at every junction traces the perimeter lap around every island,
// whatever the layout, with no authored input.
const roadPrims = prims.filter((p) => p.cls === 'road')
if (!roadPrims.length) throw new Error('no road primitives — check the rules')
let rlo = [Infinity, Infinity], rhi = [-Infinity, -Infinity]
const roadTris = []
for (const p of roadPrims) {
  const pos = p.prim.getAttribute('POSITION').getArray()
  const idx = p.prim.getIndices()?.getArray()
  const n = idx ? idx.length : pos.length / 3
  for (let t = 0; t < n; t += 3) {
    const tri = []
    for (let k = 0; k < 3; k++) { const v = idx ? idx[t + k] : t + k; const x = pos[v * 3], z = pos[v * 3 + 2]; tri.push([x, z]); rlo = [Math.min(rlo[0], x), Math.min(rlo[1], z)]; rhi = [Math.max(rhi[0], x), Math.max(rhi[1], z)] }
    roadTris.push(tri)
  }
}
const RES = 1, PAD = 4
const gx0 = Math.floor(rlo[0]) - PAD, gz0 = Math.floor(rlo[1]) - PAD
const GW = Math.ceil(rhi[0]) + PAD - gx0 + 1, GH = Math.ceil(rhi[1]) + PAD - gz0 + 1
let grid = new Uint8Array(GW * GH)
const cellX = (x) => Math.round((x - gx0) / RES), cellZ = (z) => Math.round((z - gz0) / RES)
for (const tri of roadTris) {
  // scanline fill in cell space (cell centres)
  const c = tri.map(([x, z]) => [(x - gx0) / RES, (z - gz0) / RES])
  const zmin = Math.max(0, Math.ceil(Math.min(c[0][1], c[1][1], c[2][1]))), zmax = Math.min(GH - 1, Math.floor(Math.max(c[0][1], c[1][1], c[2][1])))
  for (let cz = zmin; cz <= zmax; cz++) {
    const xs = []
    for (let e = 0; e < 3; e++) {
      const a = c[e], b = c[(e + 1) % 3]
      if ((cz >= a[1] && cz < b[1]) || (cz >= b[1] && cz < a[1])) xs.push(a[0] + ((cz - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
    }
    if (xs.length < 2) continue
    xs.sort((u, v) => u - v)
    for (let cx = Math.max(0, Math.ceil(xs[0])); cx <= Math.min(GW - 1, Math.floor(xs[1])); cx++) grid[cz * GW + cx] = 1
  }
}
const at = (g, x, z) => (x < 0 || z < 0 || x >= GW || z >= GH ? 0 : g[z * GW + x])
// Close hairline cracks between triangles: dilate then erode by one cell.
const morph = (g, fn) => { const o = new Uint8Array(GW * GH); for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) { let cnt = 0; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) cnt += at(g, x + dx, z + dz); o[z * GW + x] = fn(cnt, g[z * GW + x]) ? 1 : 0 } return o }
grid = morph(grid, (cnt) => cnt > 0)
grid = morph(grid, (cnt) => cnt === 9)
let roadCells = 0; for (const v of grid) roadCells += v
console.log(`road raster ${GW}×${GH} cells, ${roadCells} m² of asphalt`)
// Zhang–Suen thinning.
const thin = (g) => {
  const img = Uint8Array.from(g)
  let changed = true
  while (changed) {
    changed = false
    for (const pass of [0, 1]) {
      const del = []
      for (let z = 1; z < GH - 1; z++) for (let x = 1; x < GW - 1; x++) {
        if (!img[z * GW + x]) continue
        const p2 = at(img, x, z - 1), p3 = at(img, x + 1, z - 1), p4 = at(img, x + 1, z), p5 = at(img, x + 1, z + 1), p6 = at(img, x, z + 1), p7 = at(img, x - 1, z + 1), p8 = at(img, x - 1, z), p9 = at(img, x - 1, z - 1)
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
        if (B < 2 || B > 6) continue
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
        let A = 0; for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) A++
        if (A !== 1) continue
        if (pass === 0 ? p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0 : p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue
        del.push(z * GW + x)
      }
      for (const i of del) img[i] = 0
      if (del.length) changed = true
    }
  }
  return img
}
let skel = thin(grid)
const nb8 = (g, x, z) => { const out = []; for (const [dx, dz] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]) if (at(g, x + dx, z + dz)) out.push([x + dx, z + dz]); return out }
// Prune every dead end: a lap has none, so end-point chains (short spurs from
// wide areas and whole cul-de-sac roads alike) are cut back to their junction
// until no end points remain.
let pruned = 0
for (let round = 0; round < 60; round++) {
  let removed = 0
  const ends = []
  for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) if (skel[z * GW + x] && nb8(skel, x, z).length === 1) ends.push([x, z])
  for (const end of ends) {
    if (!skel[end[1] * GW + end[0]]) continue
    const chain = [end]; let prev = null, cur = end
    for (;;) { const n = nb8(skel, cur[0], cur[1]).filter((q) => !prev || q[0] !== prev[0] || q[1] !== prev[1]); if (n.length !== 1) break; prev = cur; cur = n[0]; chain.push(cur) }
    for (const [x, z] of chain.slice(0, -1)) skel[z * GW + x] = 0
    pruned += chain.length - 1
    removed++
  }
  if (!removed) break
  skel = thin(skel)
}
console.log(`pruned ${pruned} dead-end skeleton cells`)
let skelCells = 0; for (const v of skel) skelCells += v
// Skeleton → graph (junction nodes + pixel-path edges) → enumerate simple
// cycles → keep the one enclosing the largest area: the perimeter lap around
// every island. Purely geometric; no authored route.
const isJ = (x, z) => skel[z * GW + x] && nb8(skel, x, z).length >= 3
const jid = new Int32Array(GW * GH).fill(-1)
const junctions = [] // { pixels: [[x,z]], x, z }
for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) {
  if (!isJ(x, z) || jid[z * GW + x] >= 0) continue
  const id = junctions.length, pixels = [], stack = [[x, z]]
  jid[z * GW + x] = id
  while (stack.length) { const [px, pz] = stack.pop(); pixels.push([px, pz]); for (const [nx, nz] of nb8(skel, px, pz)) if (isJ(nx, nz) && jid[nz * GW + nx] < 0) { jid[nz * GW + nx] = id; stack.push([nx, nz]) } }
  junctions.push({ pixels, x: pixels.reduce((a, q) => a + q[0], 0) / pixels.length, z: pixels.reduce((a, q) => a + q[1], 0) / pixels.length })
}
const edgesG = [] // { a, b, path }
let cyclePaths
if (!junctions.length) {
  // A single loop: walk it.
  let start = null
  for (let z = 0; z < GH && !start; z++) for (let x = 0; x < GW; x++) if (skel[z * GW + x]) { start = [x, z]; break }
  const path = [start]; let prev = null, cur = start
  for (;;) { const n = nb8(skel, cur[0], cur[1]).filter((q) => !prev || q[0] !== prev[0] || q[1] !== prev[1]); if (!n.length || (n[0][0] === start[0] && n[0][1] === start[1])) break; prev = cur; cur = n[0]; path.push(cur) }
  cyclePaths = [path]
} else {
  const visitedEdge = new Set()
  for (let j = 0; j < junctions.length; j++) {
    for (const [px, pz] of junctions[j].pixels) for (const first of nb8(skel, px, pz)) {
      if (jid[first[1] * GW + first[0]] >= 0) continue // junction-to-junction contact, no chain
      const path = [[px, pz], first]
      let prev = [px, pz], cur = first, endJ = -1
      for (let guard = 0; guard < 100000; guard++) {
        const j2 = jid[cur[1] * GW + cur[0]]
        if (j2 >= 0) { endJ = j2; break }
        const n = nb8(skel, cur[0], cur[1]).filter((q) => q[0] !== prev[0] || q[1] !== prev[1])
        if (!n.length) break
        prev = cur; cur = n[0]; path.push(cur)
      }
      if (endJ < 0) continue
      const key = [j, endJ, first[0], first[1]].join(',')
      const rkey = [endJ, j, path[path.length - 2][0], path[path.length - 2][1]].join(',')
      if (visitedEdge.has(key) || visitedEdge.has(rkey)) continue
      visitedEdge.add(key)
      edgesG.push({ a: j, b: endJ, path })
    }
  }
  console.log(`skeleton graph: ${junctions.length} junctions, ${edgesG.length} edges`)
  // Enumerate simple cycles (small graph: cyclomatic number = number of islands).
  const cycles = []
  const dfs = (startNode, node, usedEdges, visitedNodes, order) => {
    for (let e = 0; e < edgesG.length; e++) {
      if (usedEdges.has(e)) continue
      const ed = edgesG[e]
      if (ed.a !== node && ed.b !== node) continue
      const next = ed.a === node ? ed.b : ed.a
      if (next === startNode && order.length >= 1) { cycles.push([...order, e]); continue }
      if (visitedNodes.has(next)) continue
      if (e < order[0]) continue // canonical: cycles start from their smallest edge id
      usedEdges.add(e); visitedNodes.add(next)
      dfs(startNode, next, usedEdges, visitedNodes, [...order, e])
      usedEdges.delete(e); visitedNodes.delete(next)
    }
  }
  for (let e0 = 0; e0 < edgesG.length && cycles.length < 5000; e0++) {
    const ed = edgesG[e0]
    if (ed.a === ed.b) { cycles.push([e0]); continue }
    dfs(ed.a, ed.b, new Set([e0]), new Set([ed.a, ed.b]), [e0])
  }
  const area = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1] } return Math.abs(a) / 2 }
  const toPoly = (cycle) => {
    const poly = []
    let node = edgesG[cycle[0]].a === (cycle.length > 1 ? (edgesG[cycle[1]].a === edgesG[cycle[0]].a || edgesG[cycle[1]].b === edgesG[cycle[0]].a ? edgesG[cycle[0]].b : edgesG[cycle[0]].a) : edgesG[cycle[0]].a) ? edgesG[cycle[0]].a : edgesG[cycle[0]].b
    // walk edges in order, orienting each so it continues from `node`
    for (const e of cycle) { const ed = edgesG[e]; const p = ed.a === node ? ed.path : [...ed.path].reverse(); poly.push(...p.slice(0, -1)); node = ed.a === node ? ed.b : ed.a }
    return poly
  }
  const dedup = new Map()
  for (const c of cycles) dedup.set([...c].sort((u, v) => u - v).join(','), c)
  const ranked = [...dedup.values()].map((c) => ({ c, poly: toPoly(c) })).map((r) => ({ ...r, area: area(r.poly) })).sort((u, v) => v.area - u.area)
  console.log(`cycles: ${ranked.length}; enclosed areas ${ranked.slice(0, 6).map((r) => Math.round(r.area) + ' m²').join(', ')}`)
  cyclePaths = ranked.map((r) => r.poly)
}
const walkPts = cyclePaths[0]
let mid = walkPts.map(([x, z]) => [gx0 + x * RES, gz0 + z * RES])
console.log(`skeleton ${skelCells} cells, lap polygon ${walkPts.length} cells`)
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
// Safety net: collapse any remaining out-and-back (samples far apart in sequence but within 3 m).
for (let guard = 0; guard < 20; guard++) {
  let best = null
  const n = mid.length
  for (let i = 0; i < n; i++) for (let j = i + 12; j < n && j - i < n - 12; j++) if (dist(mid[i], mid[j]) < 3 && (!best || j - i > best.j - best.i)) best = { i, j }
  if (!best) break
  console.log(`  collapsed a ${best.j - best.i} m spur at (${mid[best.i][0].toFixed(0)}, ${mid[best.i][1].toFixed(0)})`)
  mid = [...mid.slice(0, best.i + 1), ...mid.slice(best.j)]
}
const smooth = (arr, k) => arr.map((_, i) => { let x = 0, z = 0; for (let d = -k; d <= k; d++) { const q = arr[(i + d + arr.length) % arr.length]; x += q[0]; z += q[1] } return [x / (2 * k + 1), z / (2 * k + 1)] })
mid = smooth(smooth(smooth(mid, 3), 3), 3)
function resample(arr, step) {
  const out = [], total = arr.reduce((s, p, i) => s + dist(p, arr[(i + 1) % arr.length]), 0)
  let acc = 0, target = 0
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i], b = arr[(i + 1) % arr.length], seg = dist(a, b)
    while (target <= acc + seg && target < total) { const u = seg > 0 ? (target - acc) / seg : 0; out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); target += step }
    acc += seg
  }
  return { points: out, length: total }
}
const { points: line, length } = resample(mid, 2)
// Distance from any point to the nearest non-road cell (half the local road width).
const edgeDist = (p) => { const cx = cellX(p[0]), cz = cellZ(p[1]); for (let r = 0; r < 80; r++) { for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) { if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; if (!at(grid, cx + dx, cz + dz)) return Math.hypot(dx, dz) * RES } } return 80 }
// Orientation: drive +Z along the easternmost stretch.
const east = line.reduce((b, p, i) => (p[0] > line[b][0] ? i : b), 0)
const dzEast = line[(east + 1) % line.length][1] - line[east][1]
if (dzEast < 0) line.reverse()
// Start in the middle of the longest straight (low turning over 60 m).
const heading = (i) => { const a = line[(i - 1 + line.length) % line.length], b = line[(i + 1) % line.length]; return Math.atan2(b[0] - a[0], b[1] - a[1]) }
const turn = line.map((_, i) => { let d = heading((i + 1) % line.length) - heading(i); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d) })
let bestStart = 0, bestLen = 0
{
  const flat = turn.map((t) => t < 0.012)
  let runStart = -1
  const n = flat.length
  for (let i = 0; i < 2 * n; i++) {
    const f = flat[i % n]
    if (f && runStart < 0) runStart = i
    if ((!f || i === 2 * n - 1) && runStart >= 0) { const len = i - runStart; if (len > bestLen && len < n) { bestLen = len; bestStart = runStart } runStart = -1 }
  }
}
const startIdx = (bestStart + Math.floor(bestLen / 2)) % line.length
const ordered = [...line.slice(startIdx), ...line.slice(0, startIdx)]
// Control points every `controlSpacing` metres (Catmull-Rom through them re-creates the line).
const every = Math.max(1, Math.round(cfg.controlSpacing / 2))
const control = ordered.filter((_, i) => i % every === 0).map(([x, z]) => [+x.toFixed(1), 0, +z.toFixed(1)])
// Width profile: twice the distance from the line to the nearest road edge.
const widths = ordered.filter((_, i) => i % 5 === 0).map((p) => 2 * edgeDist(p)).sort((a, b) => a - b)
let box = [Infinity, Infinity, -Infinity, -Infinity]
for (const p of line) box = [Math.min(box[0], p[0]), Math.min(box[1], p[1]), Math.max(box[2], p[0]), Math.max(box[3], p[1])]

if (flags.includes('--map')) {
  const skelPts = []
  for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) if (skel[z * GW + x]) skelPts.push([gx0 + x * RES, gz0 + z * RES])
  fs.writeFileSync(path.join(os.tmpdir(), `${trackId}-centreline.json`), JSON.stringify({ line: ordered, skeleton: skelPts, junctions: junctions.map((j) => [gx0 + j.x * RES, gz0 + j.z * RES]) }))
}

// --- rebuild hierarchy: road / terrain / wall / prop nodes ----------------------
for (const child of scene.listChildren()) scene.removeChild(child)
const targets = {}
for (const cls of ['road', 'terrain', 'wall', 'prop']) { const n = doc.createNode(cls); scene.addChild(n); targets[cls] = n }
const groups = new Map()
for (const p of prims) { const t = targets[p.cls]; (groups.get(t) ?? groups.set(t, []).get(t)).push(p.prim) }
for (const mesh of root.listMeshes()) mesh.dispose()
let drawCalls = 0, tris = 0
const trisOf = (p) => (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3
for (const [target, list] of groups) {
  const byKey = new Map()
  for (const p of list) { const k = [p.getMaterial()?.getName(), p.getMode(), p.listSemantics().join(','), p.getIndices() ? 'i' : 'n'].join('|'); (byKey.get(k) ?? byKey.set(k, []).get(k)).push(p) }
  const mesh = doc.createMesh(target.getName())
  for (const same of byKey.values()) {
    const joined = same.length > 1 ? joinPrimitives(same) : same[0]
    if (same.length > 1) for (const p of same) p.dispose()
    mesh.addPrimitive(joined)
    drawCalls++
    tris += trisOf(joined)
  }
  target.setMesh(mesh)
}
if (cfg.decimate) {
  await MeshoptSimplifier.ready
  for (const [cls, ratio] of Object.entries(cfg.decimate)) {
    const mesh = targets[cls].getMesh()
    if (!mesh) continue
    const before = mesh.listPrimitives().reduce((s, p) => s + trisOf(p), 0)
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.002, filter: (p) => mesh.listPrimitives().includes(p) }))
    const after = mesh.listPrimitives().reduce((s, p) => s + trisOf(p), 0)
    tris += after - before
    console.log(`decimated ${cls}: ${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tris`)
  }
}
for (const mat of root.listMaterials()) {
  for (const o of cfg.materials ?? []) {
    if (!o.match.test(mat.getName())) continue
    if (o.alphaMode) mat.setAlphaMode(o.alphaMode)
    if (o.alphaCutoff !== undefined) mat.setAlphaCutoff(o.alphaCutoff)
    if (o.doubleSided !== undefined) mat.setDoubleSided(o.doubleSided)
  }
}
root.getAsset().copyright = cfg.credit
root.getAsset().generator = 'apex prepare-track.mjs (glTF-Transform)'

// --- textures ------------------------------------------------------------------
if (!skipTextures) {
  const isColor = (slots) => slots.some((s) => /baseColor|emissive/i.test(s))
  const isNormal = (slots) => slots.some((s) => /normal/i.test(s))
  for (const [pattern, size] of [[/baseColor|emissive/i, cfg.textures.color], [/normal/i, cfg.textures.normal], [/metallicRoughness|occlusion/i, cfg.textures.other]]) {
    await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'png', resize: [size, size], slots: pattern }))
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ktx2-'))
  const basisu = path.resolve('node_modules/basisu/bin', process.platform, process.arch, 'basisu')
  let n = 0
  for (const tex of root.listTextures()) {
    const slots = listTextureSlots(tex)
    const png = path.join(tmp, `${n}.png`), ktx = path.join(tmp, `${n}.ktx2`)
    fs.writeFileSync(png, tex.getImage())
    const args = ['-file', png, '-output_file', ktx, '-ktx2', '-mipmap', '-mip_filter', 'kaiser']
    if (isNormal(slots)) args.push('-uastc', '-uastc_level', '2', '-uastc_rdo_l', '0.75', '-normal_map', '-mip_renorm')
    else if (isColor(slots)) args.push('-uastc', '-uastc_level', '2', '-uastc_rdo_l', '1.0')
    else args.push('-linear', '-q', '200', '-comp_level', '2')
    execFileSync(basisu, args, { stdio: 'pipe' })
    const bytes = fs.readFileSync(ktx)
    tex.setImage(new Uint8Array(bytes)).setMimeType('image/ktx2').setURI('')
    console.log(`  ktx2 ${(tex.getName() || `#${n}`).padEnd(28)} ${String(slots).padEnd(26)} → ${(bytes.length / 1048576).toFixed(2)} MB`)
    n++
  }
  doc.createExtension(KHRTextureBasisu).setRequired(true)
  fs.rmSync(tmp, { recursive: true, force: true })
}

await doc.transform(dedup(), prune(), weld(), draco({ method: 'edgebreaker', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }))
fs.mkdirSync(path.dirname(cfg.output), { recursive: true })
await io.write(cfg.output, doc)

// --- report ----------------------------------------------------------------------
console.log(`\n${cfg.output}: ${(fs.statSync(cfg.output).size / 1048576).toFixed(2)} MB, ${drawCalls} draw calls, ${Math.round(tris / 1000)}k tris, ${root.listTextures().length} textures, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
console.log(`lap ${length.toFixed(0)} m, ${control.length} control points, bounds x[${box[0].toFixed(0)}, ${box[2].toFixed(0)}] z[${box[1].toFixed(0)}, ${box[3].toFixed(0)}]`)
console.log(`road width along the line: min ${widths[0].toFixed(1)} median ${widths[widths.length >> 1].toFixed(1)} max ${widths[widths.length - 1].toFixed(1)} m; longest straight ${(bestLen * 2).toFixed(0)} m`)
if (cfg.pointsOut) {
  fs.mkdirSync(path.dirname(cfg.pointsOut), { recursive: true })
  fs.writeFileSync(cfg.pointsOut, JSON.stringify({ generatedBy: 'tools/asset-pipeline/prepare-track.mjs', lapMetres: Math.round(length), points: control }) + '\n')
  console.log(`control points → ${cfg.pointsOut}`)
} else console.log('points:', JSON.stringify(control))
