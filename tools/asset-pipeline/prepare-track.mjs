#!/usr/bin/env node
/**
 * Turns a raw circuit model (assets-src/models/tracks/<name>/scene.gltf)
 * into a game-ready .glb under public/assets/models/tracks and derives the
 * lap centreline the game's TrackSpline needs.
 *
 *  1. bakes every node transform (plus scale/yaw) into the vertices and
 *     classifies primitives with the track's `rules` (regex on node path or
 *     material name, first match wins) into road / kerb / pit / gravel /
 *     terrain / wall / overlay / prop; the runtime maps those names to
 *     colliders and surfaces (overlay and prop get none);
 *  2. derives the centreline from the road (+ kerb) surface alone: the
 *     asphalt is rasterised (1 m cells, coarser for big circuits), thinned to
 *     a one-pixel skeleton, stripped of every dead end (paddocks, pit lanes
 *     and access roads are cul-de-sacs off the lap), turned into a junction
 *     graph, and the simple cycle enclosing the largest area is the lap;
 *  3. samples the road height under every point, orients the loop in the
 *     circuit's real direction (`direction`, as seen from above), starts it at
 *     the model's start marker (`startMarker`: start lights, gantry, painted
 *     line), else beside the pit lane, else on the longest straight; derives
 *     the pit-lane zone from the pit asphalt nearest the start, and writes
 *     control points + features to `pointsOut`;
 *  4. decimates the heavy classes (per primitive, never the lap surface),
 *     encodes textures to KTX2 and Draco-compresses the geometry.
 *
 * Nothing about the route is authored: if a road surface does not yield a
 * clean lap the script says so and stops. `map-track.mjs` draws the material
 * groups and the generated centreline for checking a config.
 *
 * Usage: node tools/asset-pipeline/prepare-track.mjs <track-id> [--skip-textures] [--points-only] [--map]
 *   --points-only rewrites the centreline JSON without touching the .glb; --map dumps
 *   the raster, skeleton, wall cells and per-point width walks to $TMPDIR/<id>-centreline.json;
 *   DEBUG_WALK=x,z prints the raster cells across the road at that world position.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions'
import { dedup, draco, joinPrimitives, listTextureSlots, prune, simplifyPrimitive, textureCompress, transformPrimitive, weld, weldPrimitive } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'

const CLASSES = ['road', 'kerb', 'pit', 'runoff', 'gravel', 'terrain', 'wall', 'overlay', 'prop']

const TRACKS = {
  drift: {
    source: 'assets-src/models/tracks/drift_race_track/scene.gltf',
    output: 'public/assets/models/tracks/drift.glb',
    pointsOut: 'src/game/tracks/data/drift.points.json',
    credit: 'Drift Race Track Free by Nicholas-3D (sketchfab.com/Nicholas01), CC-BY-ND 4.0',
    scale: 1,
    yawDeg: 0,
    direction: 'cw', // seen from above in three's frame; Drift Park has no inherent direction, this keeps its data stable
    rules: [
      { cls: 'road', path: /\/Road/ },
      { cls: 'terrain', path: /\/Terrain/ },
      { cls: 'wall', path: /\/Barrier|\/Rails/ },
    ],
    decimate: { wall: 0.35 },
    materials: [{ match: /Leaf/i, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true }],
    textures: { color: 2048, normal: 1024, other: 1024 },
    controlSpacing: 14,
  },
  spa: {
    source: 'assets-src/models/tracks/circuit_de_spa-francorchamps_2022_layout/scene.gltf',
    output: 'public/assets/models/tracks/spa.glb',
    pointsOut: 'src/game/tracks/data/spa.points.json',
    credit: 'Circuit de Spa-Francorchamps 2022 layout by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    direction: 'cw',
    startMarker: /start-lights/, // the start line sits under the model's start-light gantry
    rules: [
      { cls: 'road', material: /^asph_new|^asph_patch|^groove/ }, // the racing-groove meshes are the lap surface
      { cls: 'road', material: /^asph\./, lap: 'near' }, // general asphalt: the road's full width (plus aprons, pit exit, service roads) — widens the line, never traces it
      { cls: 'kerb', material: /^kerb|^CURB/ },
      { cls: 'pit', material: /pitlane|^asph-grv/ },
      { cls: 'runoff', material: /^carpet|^grilles/ }, // painted run-off areas; drain grilles lie flush in the road
      { cls: 'overlay', material: /^line\.|^new_AO/ },
      { cls: 'gravel', material: /^sand/ },
      { cls: 'terrain', material: /grass|^GRASS|sbancamento|construction_dirt|^Parking|road-ext|^top-ext|^water/ },
      { cls: 'wall', material: /^grails|^barriers|^jersey|^walls|concrete-barrie|^fences|fence-special|stone-wall|ivy-wall/ },
    ],
    decimate: { wall: 0.4, prop: 0.5, terrain: 0.7 },
    noShadow: /trees|treesline|grass|^GRASS|top-ext|road-ext|sand|water|Parking/,
    textures: { color: 2048, normal: 1024, other: 1024 },
    controlSpacing: 10,
  },
}

const [trackId, ...flags] = process.argv.slice(2)
const cfg = TRACKS[trackId]
if (!cfg) {
  console.error(`unknown track "${trackId}". Known: ${Object.keys(TRACKS).join(', ')}`)
  process.exit(2)
}
const skipTextures = flags.includes('--skip-textures')
const pointsOnly = flags.includes('--points-only') // recompute the centreline data without touching the .glb
const t0 = Date.now()

// --- helpers ---------------------------------------------------------------------
const mul = (a, b) => { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o }
const scaleM = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]
const yawM = (rad) => [Math.cos(rad), 0, -Math.sin(rad), 0, 0, 1, 0, 0, Math.sin(rad), 0, Math.cos(rad), 0, 0, 0, 0, 1]
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.encoder': await draco3d.createEncoderModule() })
const doc = await io.read(cfg.source)
const root = doc.getRoot()
const scene = root.listScenes()[0]

// --- collect + bake + classify ------------------------------------------------------
const prims = []
function walk(node, parentPath) {
  const pathStr = `${parentPath}/${node.getName()}`
  const mesh = node.getMesh()
  if (mesh) {
    const world = Array.from(node.getWorldMatrix())
    for (const prim of mesh.listPrimitives()) {
      const matName = prim.getMaterial()?.getName() ?? ''
      const rule = cfg.rules.find((r) => (r.path && r.path.test(pathStr)) || (r.material && r.material.test(matName)))
      const cls = rule ? rule.cls : 'prop'
      if (!CLASSES.includes(cls)) throw new Error(`bad class ${cls}`)
      prims.push({ prim, cls, pathStr, matName, world, lap: rule?.lap === undefined ? true : rule.lap, noShadow: !!(cfg.noShadow && (cfg.noShadow.test(matName) || cfg.noShadow.test(pathStr))) })
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

// --- lap surface → raster → skeleton → graph → largest cycle ----------------------------
// Lap surface: `lap: true` prims (the racing groove, kerbs) give the lap its
// topology — they exist only on the track, so run-off aprons, the pit exit and
// service roads never join the skeleton. `lap: 'near'` prims (general asphalt)
// carry the road's real width: after the skeleton is traced, every point is
// re-centred across core + near asphalt, stopping at walls, so the line sits in
// the middle of the road rather than on the rubbered racing line.
const lapPrims = prims.filter((p) => (p.cls === 'road' || p.cls === 'kerb') && p.lap)
if (!lapPrims.some((p) => p.lap === true)) throw new Error('no core road primitives — check the rules')
const trisOfPrims = (list) => {
  const out = []
  for (const p of list) {
    const pos = p.prim.getAttribute('POSITION').getArray()
    const idx = p.prim.getIndices()?.getArray()
    const n = idx ? idx.length : pos.length / 3
    for (let t = 0; t < n; t += 3) { const tri = []; for (let k = 0; k < 3; k++) { const v = idx ? idx[t + k] : t + k; tri.push([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]) } out.push(tri) }
  }
  return out
}
const coreTris = trisOfPrims(lapPrims.filter((p) => p.lap === true))
const nearTris = trisOfPrims(lapPrims.filter((p) => p.lap === 'near'))
const wallTris = trisOfPrims(prims.filter((p) => p.cls === 'wall'))
const roadTris = [...coreTris, ...nearTris] // [[x,y,z]×3] in final metres; heights are sampled from these
let rlo = [Infinity, Infinity], rhi = [-Infinity, -Infinity]
for (const tri of roadTris) for (const [x, , z] of tri) { rlo = [Math.min(rlo[0], x), Math.min(rlo[1], z)]; rhi = [Math.max(rhi[0], x), Math.max(rhi[1], z)] }
const extent = Math.max(rhi[0] - rlo[0], rhi[1] - rlo[1])
const RES = extent > 1400 ? 2 : 1
const PAD = 4
const gx0 = Math.floor(rlo[0] / RES) * RES - PAD * RES, gz0 = Math.floor(rlo[1] / RES) * RES - PAD * RES
const GW = Math.ceil((rhi[0] - gx0) / RES) + PAD + 1, GH = Math.ceil((rhi[1] - gz0) / RES) + PAD + 1
const cellX = (x) => Math.round((x - gx0) / RES), cellZ = (z) => Math.round((z - gz0) / RES)
const at = (g, x, z) => (x < 0 || z < 0 || x >= GW || z >= GH ? 0 : g[z * GW + x])
const rasterise = (tris) => {
  const g = new Uint8Array(GW * GH)
  for (const tri of tris) {
    const c = tri.map(([x, , z]) => [(x - gx0) / RES, (z - gz0) / RES])
    const zmin = Math.max(0, Math.ceil(Math.min(c[0][1], c[1][1], c[2][1]))), zmax = Math.min(GH - 1, Math.floor(Math.max(c[0][1], c[1][1], c[2][1])))
    for (let cz = zmin; cz <= zmax; cz++) {
      const xs = []
      for (let e = 0; e < 3; e++) {
        const a = c[e], b = c[(e + 1) % 3]
        if ((cz >= a[1] && cz < b[1]) || (cz >= b[1] && cz < a[1])) xs.push(a[0] + ((cz - a[1]) * (b[0] - a[0])) / (b[1] - a[1]))
      }
      if (xs.length < 2) continue
      xs.sort((u, v) => u - v)
      for (let cx = Math.max(0, Math.ceil(xs[0])); cx <= Math.min(GW - 1, Math.floor(xs[1])); cx++) g[cz * GW + cx] = 1
    }
  }
  return g
}
// Walls are vertical, so their footprint is their edges: 4-connected lines, which
// the 8-connected skeleton cannot slip through diagonally. Only walls at road level
// cut; a bridge parapet or gantry crossing above the road must not sever the lap.
const heightGrid = new Float32Array(GW * GH).fill(NaN)
for (const tri of coreTris) for (const [x, y, z] of tri) heightGrid[cellZ(z) * GW + cellX(x)] = y
const roadHeightNear = (x, z) => { for (let r = 0; r <= 3; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; const X = x + dx, Z = z + dz; if (X >= 0 && Z >= 0 && X < GW && Z < GH && Number.isFinite(heightGrid[Z * GW + X])) return heightGrid[Z * GW + X] } return NaN }
const rasteriseEdges = (tris) => {
  const g = new Uint8Array(GW * GH)
  const mark = (x, z) => { if (x >= 0 && z >= 0 && x < GW && z < GH) g[z * GW + x] = 1 }
  for (const tri of tris) for (let e = 0; e < 3; e++) {
    const a = tri[e], b = tri[(e + 1) % 3]
    const low = Math.min(a[1], b[1])
    const hr = roadHeightNear(cellX((a[0] + b[0]) / 2), cellZ((a[2] + b[2]) / 2))
    if (!Number.isFinite(hr) || low > hr + 2.5 || low < hr - 4) continue
    let x0 = cellX(a[0]), z0 = cellZ(a[2]); const x1 = cellX(b[0]), z1 = cellZ(b[2])
    const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0), sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1
    let err = dx - dz
    for (let guard = 0; guard < 100000; guard++) {
      mark(x0, z0)
      if (x0 === x1 && z0 === z1) break
      const e2 = 2 * err
      if (e2 > -dz) { err -= dz; x0 += sx; mark(x0, z0) }
      if (e2 < dx) { err += dx; z0 += sz }
    }
  }
  return g
}
const morph = (g, fn) => { const o = new Uint8Array(GW * GH); for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) { let cnt = 0; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) cnt += at(g, x + dx, z + dz); o[z * GW + x] = fn(cnt, g[z * GW + x]) ? 1 : 0 } return o }
let grid = rasterise(coreTris)
grid = morph(grid, (cnt) => cnt > 0)
grid = morph(grid, (cnt) => cnt === 9)
let fullGrid = rasterise(roadTris)
fullGrid = morph(fullGrid, (cnt) => cnt > 0)
fullGrid = morph(fullGrid, (cnt) => cnt === 9)
const wallGrid = wallTris.length ? rasteriseEdges(wallTris) : null
// Kerbs are lap surface for tracing, but the usable width the AI gets stops at
// them: a 3D sausage kerb taken at speed launches a car.
const kerbTris = trisOfPrims(prims.filter((p) => p.cls === 'kerb'))
const kerbGrid = kerbTris.length ? rasteriseEdges(kerbTris) : null
let roadCells = 0; for (const v of grid) roadCells += v
console.log(`lap surface raster ${GW}×${GH} @ ${RES} m, ${Math.round(roadCells * RES * RES)} m²`)
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
let pruned = 0
for (let round = 0; round < 80; round++) {
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
let skelCells = 0; for (const v of skel) skelCells += v
if (!skelCells) throw new Error('the lap surface skeleton pruned away entirely — no closed loop in the road mesh')
const isJ = (x, z) => skel[z * GW + x] && nb8(skel, x, z).length >= 3
const jid = new Int32Array(GW * GH).fill(-1)
const junctions = []
for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) {
  if (!isJ(x, z) || jid[z * GW + x] >= 0) continue
  const id = junctions.length, pixels = [], stack = [[x, z]]
  jid[z * GW + x] = id
  while (stack.length) { const [px, pz] = stack.pop(); pixels.push([px, pz]); for (const [nx, nz] of nb8(skel, px, pz)) if (isJ(nx, nz) && jid[nz * GW + nx] < 0) { jid[nz * GW + nx] = id; stack.push([nx, nz]) } }
  junctions.push({ pixels })
}
let cyclePaths
if (!junctions.length) {
  let start = null
  for (let z = 0; z < GH && !start; z++) for (let x = 0; x < GW; x++) if (skel[z * GW + x]) { start = [x, z]; break }
  const path = [start]; let prev = null, cur = start
  for (;;) { const n = nb8(skel, cur[0], cur[1]).filter((q) => !prev || q[0] !== prev[0] || q[1] !== prev[1]); if (!n.length || (n[0][0] === start[0] && n[0][1] === start[1])) break; prev = cur; cur = n[0]; path.push(cur) }
  cyclePaths = [path]
  console.log(`skeleton ${skelCells} cells, single loop of ${path.length} cells`)
} else {
  const edgesG = []
  const visitedEdge = new Set()
  for (let j = 0; j < junctions.length; j++) {
    for (const [px, pz] of junctions[j].pixels) for (const first of nb8(skel, px, pz)) {
      if (jid[first[1] * GW + first[0]] >= 0) continue
      const path = [[px, pz], first]
      let prev = [px, pz], cur = first, endJ = -1
      for (let guard = 0; guard < 200000; guard++) {
        const j2 = jid[cur[1] * GW + cur[0]]
        if (j2 >= 0) { endJ = j2; break }
        const n = nb8(skel, cur[0], cur[1]).filter((q) => q[0] !== prev[0] || q[1] !== prev[1])
        if (!n.length) break
        prev = cur; cur = n[0]; path.push(cur)
      }
      if (endJ < 0) continue
      const key = [j, endJ, first[0], first[1]].join(','), rkey = [endJ, j, path[path.length - 2][0], path[path.length - 2][1]].join(',')
      if (visitedEdge.has(key) || visitedEdge.has(rkey)) continue
      visitedEdge.add(key)
      edgesG.push({ a: j, b: endJ, path })
    }
  }
  const cycles = []
  const dfs = (startNode, node, usedEdges, visitedNodes, order) => {
    for (let e = 0; e < edgesG.length; e++) {
      if (usedEdges.has(e)) continue
      const ed = edgesG[e]
      if (ed.a !== node && ed.b !== node) continue
      const next = ed.a === node ? ed.b : ed.a
      if (next === startNode) { cycles.push([...order, e]); continue }
      if (visitedNodes.has(next) || e < order[0]) continue
      usedEdges.add(e); visitedNodes.add(next)
      dfs(startNode, next, usedEdges, visitedNodes, [...order, e])
      usedEdges.delete(e); visitedNodes.delete(next)
    }
  }
  for (let e0 = 0; e0 < edgesG.length && cycles.length < 20000; e0++) {
    const ed = edgesG[e0]
    if (ed.a === ed.b) { cycles.push([e0]); continue }
    dfs(ed.a, ed.b, new Set([e0]), new Set([ed.a, ed.b]), [e0])
  }
  const area = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1] } return Math.abs(a) / 2 }
  const toPoly = (cycle) => {
    const first = edgesG[cycle[0]]
    let node = first.a
    if (cycle.length > 1) { const second = edgesG[cycle[1]]; node = second.a === first.b || second.b === first.b ? first.a : first.b }
    const poly = []
    for (const e of cycle) { const ed = edgesG[e]; const p = ed.a === node ? ed.path : [...ed.path].reverse(); poly.push(...p.slice(0, -1)); node = ed.a === node ? ed.b : ed.a }
    return poly
  }
  const dd = new Map()
  for (const c of cycles) dd.set([...c].sort((u, v) => u - v).join(','), c)
  const ranked = [...dd.values()].map((c) => toPoly(c)).map((poly) => ({ poly, area: area(poly) })).sort((u, v) => v.area - u.area)
  if (!ranked.length) throw new Error('the lap surface skeleton has no cycle — the road does not close')
  console.log(`skeleton ${skelCells} cells (${pruned} dead-end cells pruned), ${junctions.length} junctions, ${edgesG.length} edges, ${ranked.length} cycles; largest ${Math.round(ranked[0].area * RES * RES)} m²`)
  cyclePaths = ranked.map((r) => r.poly)
}
let mid = cyclePaths[0].map(([x, z]) => [gx0 + x * RES, gz0 + z * RES])
for (let guard = 0; guard < 20; guard++) {
  let best = null
  const n = mid.length
  for (let i = 0; i < n; i++) for (let j = i + 12; j < n && j - i < n - 12; j++) if (dist2(mid[i], mid[j]) < 3 && (!best || j - i > best.j - best.i)) best = { i, j }
  if (!best) break
  mid = [...mid.slice(0, best.i + 1), ...mid.slice(best.j)]
}
const smooth = (arr, k) => arr.map((_, i) => { let x = 0, z = 0; for (let d = -k; d <= k; d++) { const q = arr[(i + d + arr.length) % arr.length]; x += q[0]; z += q[1] } return [x / (2 * k + 1), z / (2 * k + 1)] })
const sm = Math.max(3, Math.round(6 / RES))
mid = smooth(smooth(smooth(mid, sm), sm), sm)
function resample(arr, step) {
  const out = [], total = arr.reduce((s, p, i) => s + dist2(p, arr[(i + 1) % arr.length]), 0)
  let acc = 0, target = 0
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i], b = arr[(i + 1) % arr.length], seg = dist2(a, b)
    while (target <= acc + seg && target < total) { const u = seg > 0 ? (target - acc) / seg : 0; out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); target += step }
    acc += seg
  }
  return { points: out, length: total }
}
let { points: line, length } = resample(mid, 2)
// Re-centre across the full road: walk both ways along the normal until the
// asphalt ends or a wall cell is met (max 9 m) and move to the midpoint. The raw
// midpoints jitter with the raster's jagged edges and jump at aprons and side
// roads, so the shift is median-filtered over 30 m and smoothed before it is
// applied — a wobble of a metre reads as a corner to the AI's speed profile.
const normalAt = (pts, i) => { const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L] }
// The full asphalt may only extend the core (groove) edge by a road margin — a
// side road or apron joining at a junction must not pull the line sideways.
const walkGrid = (g, p, nx, nz, sign, max, stopKerbs = false) => { let d = 0; for (let t = 0.5; t <= max; t += 0.5) { const cx = cellX(p[0] + nx * sign * t), cz = cellZ(p[1] + nz * sign * t); if (!at(g, cx, cz) || (wallGrid && at(wallGrid, cx, cz)) || (stopKerbs && kerbGrid && at(kerbGrid, cx, cz))) break; d = t } return d }
const walkFrom = (p, nx, nz, sign, stopKerbs = false) => { const core = walkGrid(grid, p, nx, nz, sign, 9); return walkGrid(fullGrid, p, nx, nz, sign, Math.min(9, core + 6), stopKerbs) }
const medianFilter = (arr, k) => arr.map((_, i) => { const w = []; for (let d = -k; d <= k; d++) w.push(arr[(i + d + arr.length) % arr.length]); w.sort((a, b) => a - b); return w[k] })
const meanFilter = (arr, k) => arr.map((_, i) => { let s = 0; for (let d = -k; d <= k; d++) s += arr[(i + d + arr.length) % arr.length]; return s / (2 * k + 1) })
let halfWidths = null
const walkDebug = []
if (nearTris.length || wallGrid) {
  const n = line.length
  const left = new Array(n), right = new Array(n)
  for (let i = 0; i < n; i++) { const [nx, nz] = normalAt(line, i); left[i] = walkFrom(line[i], nx, nz, -1); right[i] = walkFrom(line[i], nx, nz, 1) }
  const shift = meanFilter(medianFilter(left.map((l, i) => Math.max(-4, Math.min(4, (right[i] - l) / 2))), 12), 4)
  line = line.map((p, i) => { const [nx, nz] = normalAt(line, i); return [p[0] + nx * shift[i], p[1] + nz * shift[i]] })
  line = smooth(line, 2)
  ;({ points: line, length } = resample(line, 2))
  // Usable half-width at each point: the nearer edge, median-filtered.
  const hw = new Array(line.length)
  for (let i = 0; i < line.length; i++) { const [nx, nz] = normalAt(line, i); const l = walkFrom(line[i], nx, nz, -1, true), r = walkFrom(line[i], nx, nz, 1, true); hw[i] = Math.min(l, r); walkDebug.push([l, r]) }
  // The raster only marks cells whose centre is on the asphalt, so each edge reads ~0.4 cells short.
  halfWidths = meanFilter(medianFilter(hw, 12), 4).map((v) => Math.max(3, Math.min(9, v + 0.4 * RES)))
  if (process.env.DEBUG_WALK) {
    const [qx, qz] = process.env.DEBUG_WALK.split(',').map(Number)
    let i = 0, bd = Infinity
    line.forEach((p, k) => { const d = Math.hypot(p[0] - qx, p[1] - qz); if (d < bd) { bd = d; i = k } })
    const [nx, nz] = normalAt(line, i)
    for (const sign of [-1, 1]) { const cells = []; for (let t = 0; t <= 10; t += 0.5) { const cx = cellX(line[i][0] + nx * sign * t), cz = cellZ(line[i][1] + nz * sign * t); cells.push(`${t}:${at(grid, cx, cz)}${at(fullGrid, cx, cz)}${wallGrid ? at(wallGrid, cx, cz) : '-'}`) } console.log(`DEBUG_WALK idx ${i} at (${line[i][0].toFixed(0)}, ${line[i][1].toFixed(0)}) sign ${sign} [core|full|wall]: ${cells.join(' ')}`) }
  }
}

// --- direction, start point, elevation ---------------------------------------------------
const signedArea = line.reduce((a, p, i) => { const q = line[(i + 1) % line.length]; return a + p[0] * q[1] - q[0] * p[1] }, 0) / 2
// Seen from above in three's right-handed frame (+x right, +z down the page),
// a clockwise lap has positive shoelace area in (x, z).
const isCw = signedArea > 0
if ((cfg.direction === 'cw') !== isCw) { line.reverse(); if (halfWidths) halfWidths.reverse() }
// Start: beside the pit lane when the model has one, else mid-longest-straight.
const pitPts = []
for (const p of prims) if (p.cls === 'pit') { const pos = p.prim.getAttribute('POSITION').getArray(); for (let i = 0; i < pos.length; i += 3) pitPts.push([pos[i], pos[i + 1], pos[i + 2]]) }
// A start marker (start lights, gantry, painted line) pins the start line; otherwise
// the pit lane centroid does, and a track without either starts mid-longest-straight.
const markerPts = []
if (cfg.startMarker) for (const p of prims) if (cfg.startMarker.test(p.matName) || cfg.startMarker.test(p.pathStr)) { const pos = p.prim.getAttribute('POSITION').getArray(); for (let i = 0; i < pos.length; i += 3) markerPts.push([pos[i], pos[i + 1], pos[i + 2]]) }
const centroid2 = (pts) => pts.reduce((s, q) => [s[0] + q[0], s[1] + q[2]], [0, 0]).map((v) => v / pts.length)
const nearestTo = (c) => { let bd = Infinity, bi = 0; line.forEach((p, i) => { const d = dist2(p, c); if (d < bd) { bd = d; bi = i } }); return [bi, bd] }
let startIdx = 0
let startNote = ''
if (markerPts.length) {
  const [bi, bd] = nearestTo(centroid2(markerPts))
  startIdx = bi
  startNote = `start at the model's start marker (${bd.toFixed(0)} m from it)`
} else if (pitPts.length) {
  const [bi, bd] = nearestTo(centroid2(pitPts))
  startIdx = bi
  startNote = `start beside the pit lane (${bd.toFixed(0)} m from its centroid)`
} else {
  const heading = (i) => { const a = line[(i - 1 + line.length) % line.length], b = line[(i + 1) % line.length]; return Math.atan2(b[0] - a[0], b[1] - a[1]) }
  const turn = line.map((_, i) => { let d = heading((i + 1) % line.length) - heading(i); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d) })
  let bestStart = 0, bestLen = 0, runStart = -1
  const n = turn.length
  for (let i = 0; i < 2 * n; i++) { const f = turn[i % n] < 0.012; if (f && runStart < 0) runStart = i; if ((!f || i === 2 * n - 1) && runStart >= 0) { const len = i - runStart; if (len > bestLen && len < n) { bestLen = len; bestStart = runStart } runStart = -1 } }
  startIdx = (bestStart + Math.floor(bestLen / 2)) % line.length
  startNote = `start mid-longest-straight (${bestLen * 2} m)`
}
line = [...line.slice(startIdx), ...line.slice(0, startIdx)]
if (halfWidths) halfWidths = [...halfWidths.slice(startIdx), ...halfWidths.slice(0, startIdx)]
// Elevation: barycentric height of the lap-surface triangle under each point
// (nearest road vertex within 12 m as a fallback), then lightly smoothed.
const tgrid = new Map(), TC = 20
for (const tri of roadTris) {
  const xs = tri.map((v) => v[0]), zs = tri.map((v) => v[2])
  for (let cx = Math.floor(Math.min(...xs) / TC); cx <= Math.floor(Math.max(...xs) / TC); cx++) for (let cz = Math.floor(Math.min(...zs) / TC); cz <= Math.floor(Math.max(...zs) / TC); cz++) { const k = `${cx},${cz}`; (tgrid.get(k) ?? tgrid.set(k, []).get(k)).push(tri) }
}
const heightAt = ([x, z]) => {
  const k = `${Math.floor(x / TC)},${Math.floor(z / TC)}`
  let best = null, bestD = Infinity
  for (const tri of tgrid.get(k) ?? []) {
    const [a, b, c] = tri
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    if (Math.abs(d) < 1e-9) continue
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d
    const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d
    const l3 = 1 - l1 - l2
    if (l1 >= -0.02 && l2 >= -0.02 && l3 >= -0.02) return l1 * a[1] + l2 * b[1] + l3 * c[1]
    for (const v of tri) { const dv = Math.hypot(v[0] - x, v[2] - z); if (dv < bestD) { bestD = dv; best = v[1] } }
  }
  return bestD < 12 ? best : null
}
let ys = line.map(heightAt)
let missing = 0
for (let i = 0; i < ys.length; i++) if (ys[i] === null) { missing++; let j = 1; while (j < ys.length && ys[(i + j) % ys.length] === null) j++; ys[i] = ys[(i + j) % ys.length] ?? 0 }
ys = ys.map((_, i) => { let s = 0; for (let d = -2; d <= 2; d++) s += ys[(i + d + ys.length) % ys.length]; return s / 5 })
const every = Math.max(1, Math.round(cfg.controlSpacing / 2))
const control = line.filter((_, i) => i % every === 0).map(([x, z], k) => [+x.toFixed(1), +ys[k * every].toFixed(2), +z.toFixed(1)])
const controlWidths = halfWidths ? halfWidths.filter((_, i) => i % every === 0).map((v) => +v.toFixed(1)) : undefined
// Pit zone: the span of the lap that runs alongside pit asphalt.
let pitFeature = null
if (pitPts.length) {
  const pgrid = new Map()
  for (const q of pitPts) { const k = `${Math.floor(q[0] / TC)},${Math.floor(q[2] / TC)}`; (pgrid.get(k) ?? pgrid.set(k, []).get(k)).push(q) }
  const nearPit = (p) => { const cx = Math.floor(p[0] / TC), cz = Math.floor(p[1] / TC); for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const q of pgrid.get(`${cx + dx},${cz + dz}`) ?? []) if (Math.hypot(q[0] - p[0], q[2] - p[1]) < 30) return q; return null }
  const near = line.map(nearPit)
  // Runs of samples alongside pit asphalt; a model may carry several pit lanes
  // (Spa keeps its old Eau Rouge pits), so take the one closest to the start.
  const n = near.length
  const runs = new Map()
  let run = -1
  for (let i = 0; i < 2 * n; i++) { const f = !!near[i % n]; if (f && run < 0) run = i; if ((!f || i === 2 * n - 1) && run >= 0) { const len = Math.min(i - run, n); if (len * 2 > 120) runs.set(run % n, Math.max(runs.get(run % n) ?? 0, len)); run = -1 } }
  let bestS = -1, bestL = 0, bestD = Infinity
  for (const [s, len] of runs) { const m = (s + Math.floor(len / 2)) % n; const d = Math.min(m, n - m); if (d < bestD || (d === bestD && len > bestL)) { bestD = d; bestS = s; bestL = len } }
  if (bestL > 0) {
    const midI = (bestS + Math.floor(bestL / 2)) % n
    const q = near[midI], p = line[midI], nxt = line[(midI + 1) % n]
    const tx = nxt[0] - p[0], tz = nxt[1] - p[1]
    // right = up × tangent = (tz, -tx) in (x, z), matching TrackSpline
    const side = (q[0] - p[0]) * tz + (q[2] - p[1]) * -tx > 0 ? 1 : -1
    pitFeature = { type: 'pit', from: +(((bestS % n) * 2) / length).toFixed(3), to: +((((bestS + bestL) % n) * 2) / length).toFixed(3), side }
  }
}

// --- widths + bounds + optional map dump ------------------------------------------------------
const edgeDist = (p) => { const cx = cellX(p[0]), cz = cellZ(p[1]); for (let r = 0; r < 60; r++) { for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) { if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; if (!at(grid, cx + dx, cz + dz)) return Math.hypot(dx, dz) * RES } } return 60 * RES }
const widths = line.filter((_, i) => i % 5 === 0).map((p) => 2 * edgeDist(p)).sort((a, b) => a - b)
let box = [Infinity, Infinity, -Infinity, -Infinity]
for (const p of line) box = [Math.min(box[0], p[0]), Math.min(box[1], p[1]), Math.max(box[2], p[0]), Math.max(box[3], p[1])]
if (flags.includes('--map')) {
  const skelPts = []
  for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) if (skel[z * GW + x]) skelPts.push([gx0 + x * RES, gz0 + z * RES])
  const wallPts = []
  if (wallGrid) for (let z = 0; z < GH; z++) for (let x = 0; x < GW; x++) if (wallGrid[z * GW + x]) wallPts.push([gx0 + x * RES, gz0 + z * RES])
  fs.writeFileSync(path.join(os.tmpdir(), `${trackId}-centreline.json`), JSON.stringify({ line, skeleton: skelPts, walls: wallPts, res: RES, walks: walkDebug, startIdx, road: roadTris.map((t) => t.map((v) => [+v[0].toFixed(1), +v[2].toFixed(1)])), pit: pitPts.filter((_, i) => i % 3 === 0).map((q) => [+q[0].toFixed(1), +q[2].toFixed(1)]) }))
}

// --- rebuild hierarchy: one node per class -------------------------------------------------
if (pointsOnly) {
  const features = pitFeature ? [pitFeature] : []
  fs.mkdirSync(path.dirname(cfg.pointsOut), { recursive: true })
  fs.writeFileSync(cfg.pointsOut, JSON.stringify({ generatedBy: 'tools/asset-pipeline/prepare-track.mjs', lapMetres: Math.round(length), features, points: control, ...(controlWidths ? { halfWidths: controlWidths } : {}) }) + '\n')
  console.log(`lap ${length.toFixed(0)} m (${cfg.direction}), ${control.length} control points → ${cfg.pointsOut}; ${startNote}; elevation ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)} m`)
  if (pitFeature) console.log(`pit lane: t ${pitFeature.from}..${pitFeature.to} on side ${pitFeature.side > 0 ? 'right' : 'left'}`)
  process.exit(0)
}
for (const child of scene.listChildren()) scene.removeChild(child)
const targets = {}
for (const cls of CLASSES) for (const shadow of [true, false]) { const name = shadow ? cls : `${cls}_noshadow`; const n = doc.createNode(name); scene.addChild(n); targets[name] = n }
const groups = new Map()
for (const p of prims) { const t = targets[p.noShadow ? `${p.cls}_noshadow` : p.cls]; (groups.get(t) ?? groups.set(t, []).get(t)).push(p.prim) }
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
for (const [name, node] of Object.entries(targets)) if (!node.getMesh()) { scene.removeChild(node); node.dispose(); delete targets[name] }
if (cfg.decimate) {
  await MeshoptSimplifier.ready
  for (const [cls, ratio] of Object.entries(cfg.decimate)) {
    for (const name of [cls, `${cls}_noshadow`]) {
      const mesh = targets[name]?.getMesh()
      if (!mesh) continue
      const before = mesh.listPrimitives().reduce((s, p) => s + trisOf(p), 0)
      // Per primitive: the document-wide simplify() has no filter and would
      // decimate the lap surface too (it once cut Spa's road to 5 % of its triangles).
      for (const p of mesh.listPrimitives()) {
        weldPrimitive(p)
        const q = simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio, error: 0.002 })
        if (q !== p) { mesh.removePrimitive(p); mesh.addPrimitive(q); p.dispose() }
      }
      const after = mesh.listPrimitives().reduce((s, p) => s + trisOf(p), 0)
      tris += after - before
      console.log(`decimated ${name}: ${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tris`)
    }
  }
}
for (const mat of root.listMaterials()) {
  const tr = mat.getExtension('KHR_materials_transmission')
  if (tr) { mat.setExtension('KHR_materials_transmission', null); tr.dispose(); const c = mat.getBaseColorFactor(); mat.setAlphaMode('BLEND').setBaseColorFactor([c[0], c[1], c[2], Math.min(c[3], 0.45)]) }
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
  for (const [pattern, size] of [[/baseColor|emissive/i, cfg.textures.color], [/normal/i, cfg.textures.normal], [/metallicRoughness|occlusion|specular/i, cfg.textures.other]]) {
    await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'png', resize: [size, size], slots: pattern }))
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ktx2-'))
  const basisu = path.resolve('node_modules/basisu/bin', process.platform, process.arch, 'basisu')
  let n = 0, bytesTotal = 0
  for (const tex of root.listTextures()) {
    const slots = listTextureSlots(tex)
    const png = path.join(tmp, `${n}.png`), ktx = path.join(tmp, `${n}.ktx2`)
    fs.writeFileSync(png, tex.getImage())
    // basisu needs dimensions divisible by 4; pad tiny textures by resizing.
    const meta = await sharp(png).metadata()
    if (meta.width % 4 || meta.height % 4 || meta.width < 4 || meta.height < 4) await sharp(png).resize(Math.max(4, Math.ceil(meta.width / 4) * 4), Math.max(4, Math.ceil(meta.height / 4) * 4), { fit: 'fill' }).toFile(png + '.p.png').then(() => fs.renameSync(png + '.p.png', png))
    const args = ['-file', png, '-output_file', ktx, '-ktx2', '-mipmap', '-mip_filter', 'kaiser']
    if (isNormal(slots)) args.push('-uastc', '-uastc_level', '2', '-uastc_rdo_l', '0.75', '-normal_map', '-mip_renorm')
    else if (isColor(slots)) args.push('-uastc', '-uastc_level', '2', '-uastc_rdo_l', '1.0')
    else args.push('-linear', '-q', '200', '-comp_level', '2')
    try {
      execFileSync(basisu, args, { stdio: 'pipe' })
      const bytes = fs.readFileSync(ktx)
      bytesTotal += bytes.length
      tex.setImage(new Uint8Array(bytes)).setMimeType('image/ktx2').setURI('')
    } catch (err) {
      console.warn(`  texture #${n} (${slots}) kept as PNG: ${String(err.stderr || err.message).split('\n')[0].slice(0, 120)}`)
    }
    n++
  }
  doc.createExtension(KHRTextureBasisu).setRequired(true)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`  ${n} textures → ${(bytesTotal / 1048576).toFixed(1)} MB KTX2`)
}
await doc.transform(dedup(), prune({ keepLeaves: true }), weld(), draco({ method: 'edgebreaker', quantizePosition: 20, quantizeNormal: 10, quantizeTexcoord: 12 })) // 20 bits: ~2 mm over a 2 km circuit; 14 bits (13 cm) made the road bumpy and split stacked surfaces)
fs.mkdirSync(path.dirname(cfg.output), { recursive: true })
await io.write(cfg.output, doc)

// --- report + data -----------------------------------------------------------------
const features = pitFeature ? [pitFeature] : []
fs.mkdirSync(path.dirname(cfg.pointsOut), { recursive: true })
fs.writeFileSync(cfg.pointsOut, JSON.stringify({ generatedBy: 'tools/asset-pipeline/prepare-track.mjs', lapMetres: Math.round(length), features, points: control, ...(controlWidths ? { halfWidths: controlWidths } : {}) }) + '\n')
console.log(`\n${cfg.output}: ${(fs.statSync(cfg.output).size / 1048576).toFixed(2)} MB, ${drawCalls} draw calls, ${Math.round(tris / 1000)}k tris, ${root.listTextures().length} textures, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
console.log(`lap ${length.toFixed(0)} m (${cfg.direction}), ${control.length} control points → ${cfg.pointsOut}; ${startNote}; elevation ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)} m (${missing} samples off the mesh)`)
console.log(`road width along the line: min ${widths[0].toFixed(1)} median ${widths[widths.length >> 1].toFixed(1)} max ${widths[widths.length - 1].toFixed(1)} m; bounds x[${box[0].toFixed(0)}, ${box[2].toFixed(0)}] z[${box[1].toFixed(0)}, ${box[3].toFixed(0)}]`)
if (pitFeature) console.log(`pit lane: t ${pitFeature.from}..${pitFeature.to} on side ${pitFeature.side > 0 ? 'right' : 'left'}`)
else console.log('pit lane: none detected')
