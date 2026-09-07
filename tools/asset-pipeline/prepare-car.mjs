#!/usr/bin/env node
/**
 * Turns a raw Sketchfab glTF car (assets-src/models/cars/<name>/scene.gltf)
 * into a game-ready .glb under public/assets/models/cars:
 *
 *  1. re-frames the model in metres, +Z forward, ground at y = 0 and x/z = 0
 *     at the wheelbase midpoint (the frame VehicleController/CarModelLoader
 *     assume), baking every node transform into the vertices;
 *  2. rigs the wheels: each tyre becomes wheel_N/wheel_N_spin (N = FL, FR,
 *     RL, RR), meshes that span both sides of an axle (rims, brake drums)
 *     are split by triangle position into left/right halves and attached to
 *     the matching wheel — spinning parts under *_spin, steering-only parts
 *     under wheel_N;
 *  3. groups everything else under `body`, with `cockpit_hidden` (the
 *     model's own steering wheel) and `light_brake` (emissive brake lamps)
 *     as named children, and joins primitives per material to cut draw calls;
 *  4. strips KHR_materials_transmission (three renders it with a costly
 *     extra scene pass) in favour of plain alpha blending;
 *  5. shrinks textures (colour 2048, normals/other 1024 by default), encodes
 *     them to KTX2 with the basisu CLI (UASTC for colour + normals, ETC1S for
 *     roughness/metal), mipmapped, and Draco-compresses the geometry.
 *
 * It prints the measured wheelbase, track, wheel radius/width and the final
 * positions of named parts so the VehicleCatalog entry can be filled in.
 *
 * Usage: node tools/asset-pipeline/prepare-car.mjs <car-id> [--skip-textures]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions'
import { dedup, draco, joinPrimitives, listTextureSlots, prune, textureCompress, transformPrimitive, weld } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import sharp from 'sharp'

const CARS = {
  w13: {
    source: 'assets-src/models/cars/f1_mercedes_w13_concept/scene.gltf',
    output: 'public/assets/models/cars/w13.glb',
    credit: 'F1 Mercedes W13 Concept by Nick Broad (sketchfab.com/nickbroad), CC-BY 4.0',
    scale: 0.01,
    yawDeg: 180, // the model faces -Z; game cars face +Z
    tyres: ['FrontTyre', 'FrontTyre.004', 'RearTyre', 'RearTyre.001'],
    spinSplit: ['FronyWheelHub', 'RearWheelHub'], // rims + brake ducts, both sides in one mesh
    steerSplit: ['FrontWheelHubInner', 'RearWheelHubInner'], // brake drums: steer, no spin
    cockpitHidden: [/^SteeringWheel/, /^SteeringCog/, /^SteeringColumn/],
    brakeLights: [/GlassLight/],
    report: [/^Headrest/, /^HaloWing/, /^T-Cam/, /^Exhaust/, /^WindScreen/, /^SteeringWheel\.013/, /^Seat/],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
}

const [carId, ...flags] = process.argv.slice(2)
const cfg = CARS[carId]
if (!cfg) {
  console.error(`unknown car "${carId}". Known: ${Object.keys(CARS).join(', ')}`)
  process.exit(2)
}
const skipTextures = flags.includes('--skip-textures')
const t0 = Date.now()

// --- tiny mat4 helpers (column-major, like glTF / gl-matrix) -----------------
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const mul = (a, b) => {
  const o = new Array(16).fill(0)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]
  return o
}
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
const scaleM = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]
const yawM = (rad) => [Math.cos(rad), 0, -Math.sin(rad), 0, 0, 1, 0, 0, Math.sin(rad), 0, Math.cos(rad), 0, 0, 0, 0, 1]
const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.encoder': await draco3d.createEncoderModule() })
const doc = await io.read(cfg.source)
const root = doc.getRoot()
const scene = root.listScenes()[0]
const buffer = root.listBuffers()[0]

// --- collect mesh nodes with their source world matrices -------------------
const meshNodes = []
scene.traverse((n) => {
  if (n.getMesh()) meshNodes.push({ node: n, world: Array.from(n.getWorldMatrix()) })
})
const findNamed = (name) => {
  let hit = null
  scene.traverse((n) => {
    if (!hit && n.getName() === name) hit = n
  })
  if (!hit) throw new Error(`node "${name}" not found`)
  return hit
}
const subtreeMeshNodes = (name) => {
  const out = new Set()
  findNamed(name).traverse((n) => {
    if (n.getMesh()) out.add(n)
  })
  return out
}

/** AABB of a primitive after a matrix, from the accessor bounds. */
function primBounds(prim, m) {
  const acc = prim.getAttribute('POSITION')
  const mn = acc.getMin([]), mx = acc.getMax([])
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const x of [mn[0], mx[0]]) for (const y of [mn[1], mx[1]]) for (const z of [mn[2], mx[2]]) {
    const q = xf(m, [x, y, z])
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], q[i]); hi[i] = Math.max(hi[i], q[i]) }
  }
  return { lo, hi }
}
const nodeBounds = (entry, m) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const p of entry.node.getMesh().listPrimitives()) {
    const b = primBounds(p, mul(m, entry.world))
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b.lo[i]); hi[i] = Math.max(hi[i], b.hi[i]) }
  }
  return { lo, hi, centre: lo.map((v, i) => (v + hi[i]) / 2) }
}

// --- root re-frame: scale + yaw, then shift so ground = 0, wheelbase mid = 0 --
const R0 = mul(yawM((cfg.yawDeg * Math.PI) / 180), scaleM(cfg.scale))
const tyreSets = cfg.tyres.map(subtreeMeshNodes)
const tyreEntries = tyreSets.map((set) => meshNodes.filter((e) => set.has(e.node)))
const tyreBounds0 = tyreEntries.map((entries) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const e of entries) { const b = nodeBounds(e, R0); for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b.lo[i]); hi[i] = Math.max(hi[i], b.hi[i]) } }
  return { lo, hi, centre: lo.map((v, i) => (v + hi[i]) / 2) }
})
const groundY = Math.min(...tyreBounds0.map((b) => b.lo[1]))
const zs = tyreBounds0.map((b) => b.centre[2])
const zMid = (Math.max(...zs) + Math.min(...zs)) / 2
const xMid = tyreBounds0.reduce((s, b) => s + b.centre[0], 0) / tyreBounds0.length
const R = mul(translate(-xMid, -groundY, -zMid), R0)

// Final tyre centres → wheel indices (FL, FR, RL, RR = physics order).
const tyreInfo = tyreBounds0.map((b) => {
  const c = [b.centre[0] - xMid, b.centre[1] - groundY, b.centre[2] - zMid]
  const index = (c[2] > 0 ? 0 : 2) + (c[0] < 0 ? 0 : 1)
  return { centre: c, index, radius: (b.hi[1] - b.lo[1]) / 2, width: b.hi[0] - b.lo[0] }
})
if (new Set(tyreInfo.map((t) => t.index)).size !== 4) throw new Error('tyres did not map to four distinct corners: ' + JSON.stringify(tyreInfo))
const wheelCentre = (i) => tyreInfo.find((t) => t.index === i).centre

// --- build the target hierarchy --------------------------------------------
// Name lookups must happen while the source hierarchy is still attached.
const spinSets = cfg.spinSplit.map(subtreeMeshNodes)
const steerSets = cfg.steerSplit.map(subtreeMeshNodes)
for (const child of scene.listChildren()) scene.removeChild(child) // old roots are pruned later
const mkNode = (name, parent) => { const n = doc.createNode(name); parent.addChild(n); return n }
const bodyNode = mkNode('body', scene)
const cockpitNode = mkNode('cockpit_hidden', bodyNode)
const brakeNode = mkNode('light_brake', bodyNode)
const wheelNodes = [], spinNodes = []
for (let i = 0; i < 4; i++) {
  const c = wheelCentre(i)
  const w = mkNode(`wheel_${i}`, scene).setTranslation(c)
  wheelNodes.push(w)
  spinNodes.push(mkNode(`wheel_${i}_spin`, w))
}
const groups = new Map() // target node → primitives
const addPrim = (target, prim) => { if (!groups.has(target)) groups.set(target, []); groups.get(target).push(prim) }

/** Copy the triangles listed in `tris` into a fresh primitive with compact, unshared accessors. */
function subsetPrimitive(prim, tris, positions, indices) {
  const remap = new Map(), order = []
  const newIdx = []
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const v = indices ? indices[t * 3 + k] : t * 3 + k
    if (!remap.has(v)) { remap.set(v, order.length); order.push(v) }
    newIdx.push(remap.get(v))
  }
  const out = doc.createPrimitive().setMode(prim.getMode()).setMaterial(prim.getMaterial())
  for (const sem of prim.listSemantics()) {
    const src = prim.getAttribute(sem)
    const size = src.getElementSize()
    const arr = src.getArray()
    const dst = new arr.constructor(order.length * size)
    order.forEach((v, i) => { for (let k = 0; k < size; k++) dst[i * size + k] = arr[v * size + k] })
    out.setAttribute(sem, doc.createAccessor().setType(src.getType()).setArray(dst).setNormalized(src.getNormalized()).setBuffer(buffer))
  }
  out.setIndices(doc.createAccessor().setType('SCALAR').setArray(order.length > 65535 ? new Uint32Array(newIdx) : new Uint16Array(newIdx)).setBuffer(buffer))
  void positions
  return out
}

/** Split a primitive (already expressed in world/model space) into left/right halves by triangle centroid x. */
function splitByX(prim) {
  const pos = prim.getAttribute('POSITION').getArray()
  const idx = prim.getIndices()?.getArray() ?? null
  const triCount = idx ? idx.length / 3 : pos.length / 9
  const left = [], right = []
  for (let t = 0; t < triCount; t++) {
    let x = 0
    for (let k = 0; k < 3; k++) { const v = idx ? idx[t * 3 + k] : t * 3 + k; x += pos[v * 3] }
    ;(x < 0 ? left : right).push(t)
  }
  return { left: left.length ? subsetPrimitive(prim, left, pos, idx) : null, right: right.length ? subsetPrimitive(prim, right, pos, idx) : null }
}

const inAny = (sets, node) => sets.some((s) => s.has(node))
const nameMatches = (list, name) => list.some((re) => re.test(name))
const report = []
let dropped = 0
for (const entry of meshNodes) {
  const { node, world } = entry
  const M = mul(R, world) // source local → final model space
  const name = node.getName()
  const mesh = node.getMesh()
  const tyreIdx = tyreSets.findIndex((s) => s.has(node))
  if (nameMatches(cfg.report, name)) { const b = nodeBounds(entry, R); report.push(`${name.padEnd(30)} (${b.lo.map((v) => v.toFixed(2)).join(', ')}) .. (${b.hi.map((v) => v.toFixed(2)).join(', ')})`) }
  for (const prim of mesh.listPrimitives()) {
    if (tyreIdx >= 0) {
      const wi = tyreInfo[tyreIdx].index
      transformPrimitive(prim, mul(translate(...wheelCentre(wi).map((v) => -v)), M))
      addPrim(spinNodes[wi], prim)
    } else if (inAny(spinSets, node) || inAny(steerSets, node)) {
      const spins = inAny(spinSets, node)
      transformPrimitive(prim, M)
      const b = primBounds(prim, I4)
      const front = (b.lo[2] + b.hi[2]) / 2 > 0
      const { left, right } = splitByX(prim)
      for (const [half, side] of [[left, 0], [right, 1]]) {
        if (!half) continue
        const wi = (front ? 0 : 2) + side
        transformPrimitive(half, translate(...wheelCentre(wi).map((v) => -v)))
        addPrim(spins ? spinNodes[wi] : wheelNodes[wi], half)
      }
      prim.dispose()
    } else {
      transformPrimitive(prim, M)
      if (nameMatches(cfg.cockpitHidden, name)) addPrim(cockpitNode, prim)
      else if (nameMatches(cfg.brakeLights, name)) addPrim(brakeNode, prim)
      else addPrim(bodyNode, prim)
    }
  }
  mesh.dispose()
  node.dispose()
}
void dropped

// Join primitives per material inside each target node → one mesh per node.
let drawCalls = 0, tris = 0
for (const [target, prims] of groups) {
  const byMat = new Map()
  for (const p of prims) { const m = p.getMaterial(); if (!byMat.has(m)) byMat.set(m, []); byMat.get(m).push(p) }
  const mesh = doc.createMesh(target.getName())
  for (const list of byMat.values()) {
    const joined = list.length > 1 ? joinPrimitives(list) : list[0]
    if (list.length > 1) for (const p of list) p.dispose()
    mesh.addPrimitive(joined)
    drawCalls++
    tris += (joined.getIndices()?.getCount() ?? joined.getAttribute('POSITION').getCount()) / 3
  }
  target.setMesh(mesh)
}

// --- materials ---------------------------------------------------------------
for (const mat of root.listMaterials()) {
  const tr = mat.getExtension('KHR_materials_transmission')
  if (tr) {
    // Transmission means an extra full-scene render pass in three; a tinted
    // alpha-blended surface reads the same on visors/lenses at racing speed.
    mat.setExtension('KHR_materials_transmission', null)
    tr.dispose()
    const c = mat.getBaseColorFactor()
    mat.setAlphaMode('BLEND').setBaseColorFactor([c[0], c[1], c[2], Math.min(c[3], 0.45)])
  }
}
root.getAsset().copyright = cfg.credit
root.getAsset().generator = 'apex prepare-car.mjs (glTF-Transform)'

// --- textures ------------------------------------------------------------------
if (!skipTextures) {
  const isColor = (slots) => slots.some((s) => /baseColor|emissive/i.test(s))
  const isNormal = (slots) => slots.some((s) => /normal/i.test(s))
  const sizeFor = (slots) => (isColor(slots) ? cfg.textures.color : isNormal(slots) ? cfg.textures.normal : cfg.textures.other)
  // Resize with sharp (PNG stays lossless until basisu) per slot class.
  for (const [pattern, size] of [[/baseColor|emissive/i, cfg.textures.color], [/normal/i, cfg.textures.normal], [/metallicRoughness|occlusion|clearcoat|specular|transmission|thickness/i, cfg.textures.other]]) {
    await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'png', resize: [size, size], slots: pattern }))
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ktx2-'))
  const basisu = path.resolve('node_modules/basisu/bin', process.platform, process.arch, 'basisu')
  let n = 0
  for (const tex of root.listTextures()) {
    const slots = listTextureSlots(tex)
    const png = path.join(tmp, `${n}.png`)
    const ktx = path.join(tmp, `${n}.ktx2`)
    fs.writeFileSync(png, tex.getImage())
    const args = ['-file', png, '-output_file', ktx, '-ktx2', '-mipmap', '-mip_filter', 'kaiser']
    if (isNormal(slots)) args.push('-uastc', '-uastc_level', '2', '-uastc_rdo_l', '0.75', '-normal_map', '-mip_renorm')
    else if (isColor(slots)) args.push('-uastc', '-uastc_level', '2', '-uastc_rdo_l', '1.0')
    else args.push('-linear', '-q', '200', '-comp_level', '2')
    const tt = Date.now()
    execFileSync(basisu, args, { stdio: 'pipe' })
    const bytes = fs.readFileSync(ktx)
    tex.setImage(new Uint8Array(bytes)).setMimeType('image/ktx2').setURI('')
    console.log(`  ktx2 ${(tex.getName() || `#${n}`).padEnd(36)} ${String(slots).padEnd(26)} ${sizeFor(slots)}px → ${(bytes.length / 1048576).toFixed(2)} MB (${((Date.now() - tt) / 1000).toFixed(1)} s)`)
    n++
  }
  doc.createExtension(KHRTextureBasisu).setRequired(true)
  fs.rmSync(tmp, { recursive: true, force: true })
}

// --- geometry compression & write ----------------------------------------------
await doc.transform(dedup(), prune(), weld(), draco({ method: 'edgebreaker', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }))
fs.mkdirSync(path.dirname(cfg.output), { recursive: true })
await io.write(cfg.output, doc)

// --- report ----------------------------------------------------------------------
const bodyB = (() => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const p of bodyNode.getMesh().listPrimitives()) { const b = primBounds(p, I4); for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b.lo[i]); hi[i] = Math.max(hi[i], b.hi[i]) } }
  return { lo, hi }
})()
const fl = wheelCentre(0), fr = wheelCentre(1), rl = wheelCentre(2), rr = wheelCentre(3)
console.log(`\n${cfg.output}: ${(fs.statSync(cfg.output).size / 1048576).toFixed(2)} MB, ${drawCalls} draw calls, ${Math.round(tris / 1000)}k tris, ${root.listTextures().length} textures, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
console.log('wheel centres FL/FR/RL/RR:', [fl, fr, rl, rr].map((c) => `(${c.map((v) => v.toFixed(3)).join(', ')})`).join(' '))
console.log(`wheelbase ${(fl[2] - rl[2]).toFixed(3)}  track front ${(fr[0] - fl[0]).toFixed(3)} rear ${(rr[0] - rl[0]).toFixed(3)}  radius ${tyreInfo.map((t) => t.radius.toFixed(3)).join('/')}  width ${tyreInfo.map((t) => t.width.toFixed(3)).join('/')}`)
console.log(`body bounds (${bodyB.lo.map((v) => v.toFixed(2)).join(', ')}) .. (${bodyB.hi.map((v) => v.toFixed(2)).join(', ')}) → length ${(bodyB.hi[2] - bodyB.lo[2]).toFixed(2)} width ${(bodyB.hi[0] - bodyB.lo[0]).toFixed(2)} height ${bodyB.hi[1].toFixed(2)}`)
console.log('named parts (final frame):\n  ' + report.join('\n  '))
