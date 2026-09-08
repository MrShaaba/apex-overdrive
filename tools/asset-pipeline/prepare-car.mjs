#!/usr/bin/env node
/**
 * Turns a raw Sketchfab glTF car (assets-src/models/cars/<name>/scene.gltf)
 * into a game-ready .glb under public/assets/models/cars:
 *
 *  1. re-frames the model in metres, +Z forward, ground at y = 0 and x/z = 0
 *     at the wheelbase midpoint (the frame VehicleController/CarModelLoader
 *     assume), baking every node transform into the vertices;
 *  2. classifies every primitive with the car's `rules` (regex on the node
 *     path or material name; first match wins) as tyre / spin / steer /
 *     cockpit / brake / body;
 *  3. rigs the wheels: tyre, spin and steer primitives are split into the
 *     four corners by triangle position (x sign, z sign about the wheelbase
 *     midpoint), so per-corner tyres, per-axle rim meshes and one-mesh
 *     wheel sets all end up as wheel_N (FL, FR, RL, RR, physics order) with
 *     a wheel_N_spin child holding the spinning parts; the tyre cluster of
 *     each corner defines the wheel centre, radius and width;
 *  4. groups everything else under `body`, with `cockpit_hidden` (the
 *     model's own steering wheel) and `light_brake` (emissive brake lamps)
 *     as named children, and joins primitives per material to cut draw calls;
 *  5. strips KHR_materials_transmission (three renders it with a costly
 *     extra scene pass) in favour of plain alpha blending, applies per-car
 *     material overrides (Sketchfab exports often mark tyres as metal);
 *  5b. with `wheelDetect: 'contact'` (wheels baked into the body, e.g. the
 *     SF-23) the four wheels are found from the ground-contact patches and
 *     carved out of the body by a per-wheel cylinder test; `decimate: ratio`
 *     runs meshoptimizer's simplifier on everything afterwards;
 *  6. shrinks textures (colour 2048, normals/other 1024 by default), encodes
 *     them to KTX2 with the basisu CLI (UASTC for colour + normals, ETC1S for
 *     roughness/metal), mipmapped, and Draco-compresses the geometry.
 *
 * It prints the measured wheelbase, track, wheel radius/width, overhangs
 * (front should be the long one for an open-wheeler — if not, flip `yawDeg`)
 * and the final positions of reported parts for the VehicleCatalog entry.
 *
 * Usage: node tools/asset-pipeline/prepare-car.mjs <car-id> [--skip-textures]
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

const CARS = {
  w13: {
    source: 'assets-src/models/cars/f1_mercedes_w13_concept/scene.gltf',
    output: 'public/assets/models/cars/w13.glb',
    credit: 'F1 Mercedes W13 Concept by Nick Broad (sketchfab.com/nickbroad), CC-BY 4.0',
    scale: 0.01,
    yawDeg: 180, // the model faces -Z; game cars face +Z
    rules: [
      { cls: 'tyre', path: /(Front|Rear)Tyre/ },
      { cls: 'steer', path: /WheelHubInner/ }, // brake drums: steer, no spin
      { cls: 'spin', path: /FronyWheelHub|RearWheelHub/ }, // rims + brake ducts, both sides in one mesh
      { cls: 'cockpit', path: /Steering/ },
      { cls: 'brake', path: /GlassLight/ },
    ],
    report: [/Headrest/, /HaloWing/, /T-Cam/, /Exhaust/, /WindScreen/, /SteeringWheel\.013/, /Seat\./],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  mcl35m: {
    source: 'assets-src/models/cars/f1_2021_mclaren_mcl35m/scene.gltf',
    output: 'public/assets/models/cars/mcl35m.glb',
    credit: 'F1 2021 McLaren MCL35M by Excalibur (sketchfab.com/excalibur), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    rules: [
      { cls: 'tyre', material: /^(tread|tyrewall)/ }, // all four tyres in one mesh
      { cls: 'spin', material: /^rim/ }, // all four rims in one mesh
      { cls: 'cockpit', material: /^st_wheel/ },
    ],
    // No roughness/metal maps: the export marks the tyres as polished metal.
    materials: [
      { match: /^(tread|tyrewall)/, metallic: 0, roughness: 0.88 },
      { match: /^rim/, metallic: 0.9, roughness: 0.3 },
      { match: /^mcl35m_png$|^mcl35m_h/, metallic: 0.15, roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.15 },
    ],
    report: [/st_wheel/, /mcl35m_h/],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  sf23: {
    source: 'assets-src/models/cars/scuderia_ferrari_f1_sf23_2023/scene.gltf',
    output: 'public/assets/models/cars/sf23.glb',
    credit: 'Scuderia Ferrari F1 SF23 2023 by Redgrund (sketchfab.com/redgrund), CC-BY 4.0',
    scale: 1.18, // 3.05 m wheelbase as exported; the real car is 3.6 m
    yawDeg: 0,
    rules: [], // one material, seven overlapping meshes: nothing to match on
    wheelDetect: 'contact', // wheels are baked into the body — find them from the ground-contact patches
    decimate: 0.4, // 713k tris → ~285k
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  mp45: {
    source: 'assets-src/models/cars/mclaren_mp45__formula_1/scene.gltf',
    output: 'public/assets/models/cars/mp45.glb',
    credit: 'McLaren MP4/5 || Formula 1 by dark_igorek (sketchfab.com/dark_igorek), CC-BY 4.0',
    scale: 0.597, // 3.57 m wide as exported; the real car is 2.13 m
    yawDeg: 0,
    rules: [
      { cls: 'tyre', path: /(front|back)_wheels/ }, // tyre + rim per axle, one mesh
      { cls: 'cockpit', path: /steering wheel/ },
    ],
    report: [/steering wheel/, /gear_switch/, /interior_details_4\/Object_18/],
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
const emptyBox = () => ({ lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] })
const growBox = (box, p) => { for (let i = 0; i < 3; i++) { box.lo[i] = Math.min(box.lo[i], p[i]); box.hi[i] = Math.max(box.hi[i], p[i]) } }
const boxCentre = (b) => b.lo.map((v, i) => (v + b.hi[i]) / 2)
const fmt = (v) => v.map((x) => x.toFixed(2)).join(', ')

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.encoder': await draco3d.createEncoderModule() })
const doc = await io.read(cfg.source)
const root = doc.getRoot()
const scene = root.listScenes()[0]
const buffer = root.listBuffers()[0]

/** Exact bounds of a primitive from its vertex data (after any baking). */
function primBounds(prim) {
  const pos = prim.getAttribute('POSITION').getArray()
  const box = emptyBox()
  for (let i = 0; i < pos.length; i += 3) growBox(box, [pos[i], pos[i + 1], pos[i + 2]])
  return box
}

// --- collect primitives with their node path and classification ---------------
const CLASSES = ['tyre', 'spin', 'steer', 'cockpit', 'brake', 'body']
const matches = (rule, pathStr, matName) => (rule.path ? rule.path.test(pathStr) : false) || (rule.material ? rule.material.test(matName) : false)
const prims = [] // { prim, cls, pathStr, matName }
function walk(node, parentPath) {
  const pathStr = `${parentPath}/${node.getName()}`
  const mesh = node.getMesh()
  if (mesh) {
    const world = Array.from(node.getWorldMatrix())
    for (const prim of mesh.listPrimitives()) {
      const matName = prim.getMaterial()?.getName() ?? ''
      const rule = cfg.rules.find((r) => matches(r, pathStr, matName))
      prims.push({ prim, cls: rule ? rule.cls : 'body', pathStr, matName, world })
    }
  }
  for (const c of node.listChildren()) walk(c, pathStr)
}
for (const c of scene.listChildren()) walk(c, '')
for (const p of prims) if (!CLASSES.includes(p.cls)) throw new Error(`bad class ${p.cls}`)

// Pass 1: bake node transforms + scale + yaw into the vertices.
const R0 = mul(yawM((cfg.yawDeg * Math.PI) / 180), scaleM(cfg.scale))
for (const p of prims) transformPrimitive(p.prim, mul(R0, p.world))

/** Copy the triangles listed in `tris` into a fresh primitive with compact, unshared accessors. */
function subsetPrimitive(prim, tris, indices) {
  const remap = new Map(), order = [], newIdx = []
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
  return out
}
/** Split a model-space primitive into the four corners by triangle centroid (x sign, z sign). Returns [FL, FR, RL, RR] or null. */
function splitCorners(prim) {
  const pos = prim.getAttribute('POSITION').getArray()
  const idx = prim.getIndices()?.getArray() ?? null
  const triCount = idx ? idx.length / 3 : pos.length / 9
  const buckets = [[], [], [], []]
  for (let t = 0; t < triCount; t++) {
    let x = 0, z = 0
    for (let k = 0; k < 3; k++) { const v = idx ? idx[t * 3 + k] : t * 3 + k; x += pos[v * 3]; z += pos[v * 3 + 2] }
    buckets[(z > 0 ? 0 : 2) + (x < 0 ? 0 : 1)].push(t)
  }
  return buckets.map((b) => (b.length ? subsetPrimitive(prim, b, idx) : null))
}

/**
 * Wheels baked into the body (no tyre material or node): find them from the
 * ground-contact patches. Each corner's radius comes from the tyre's top,
 * and its width from the x-slices whose ring of vertices at tread radius
 * goes (almost) all the way round — floor and bodywork only cover the
 * bottom of that ring, so they cannot stretch the tyre inboard.
 */
function detectWheelsByContact() {
  const arrays = prims.map((p) => p.prim.getAttribute('POSITION').getArray())
  let ground = Infinity
  for (const a of arrays) for (let i = 1; i < a.length; i += 3) ground = Math.min(ground, a[i])
  const low = []
  for (const a of arrays) for (let i = 0; i < a.length; i += 3) if (a[i + 1] < ground + 0.012) low.push([a[i], a[i + 1], a[i + 2]])
  const zm = low.reduce((s, v) => s + v[2], 0) / low.length
  const clusters = [[], [], [], []]
  for (const v of low) clusters[(v[2] > zm ? 0 : 2) + (v[0] < 0 ? 0 : 1)].push(v)
  const wheels = clusters.map((c, i) => {
    if (!c.length) throw new Error(`no ground contact found for corner ${i}`)
    const cx0 = c.reduce((s, v) => s + v[0], 0) / c.length
    const cz = c.reduce((s, v) => s + v[2], 0) / c.length
    let top = ground
    for (const a of arrays) for (let k = 0; k < a.length; k += 3) if (Math.abs(a[k] - cx0) < 0.12 && Math.abs(a[k + 2] - cz) < 0.08) top = Math.max(top, a[k + 1])
    const radius = (top - ground) / 2
    const yc = ground + radius
    const SLICE = 0.01, BINS = 24
    const slices = new Map()
    for (const a of arrays) for (let k = 0; k < a.length; k += 3) {
      const dx = a[k] - cx0
      if (Math.abs(dx) > 0.6) continue
      const dy = a[k + 1] - yc, dz = a[k + 2] - cz
      const rad = Math.hypot(dy, dz)
      if (rad < radius * 0.85 || rad > radius * 1.03) continue
      const s = Math.round(dx / SLICE)
      const bin = Math.floor(((Math.atan2(dz, dy) + Math.PI) / (2 * Math.PI)) * BINS) % BINS
      if (!slices.has(s)) slices.set(s, new Set())
      slices.get(s).add(bin)
    }
    // Full rings sit at the tread edges (the tread itself is long strips with
    // no interior vertices): the tyre spans from the outermost ring to the
    // innermost ring within a plausible tyre width of it.
    const good = [...slices.entries()].filter(([, bins]) => bins.size >= BINS * 0.75).map(([s]) => s)
    if (!good.length) throw new Error(`corner ${i}: no full tread ring found`)
    const sign = cx0 < 0 ? -1 : 1
    const sOut = good.reduce((a, b) => (b * sign > a * sign ? b : a))
    const sIn = good.filter((s) => (sOut - s) * sign <= 0.5 / SLICE).reduce((a, b) => (b * sign < a * sign ? b : a))
    const xOut = cx0 + sOut * SLICE, xIn = cx0 + sIn * SLICE
    console.log(`  corner ${i}: rings at ${good.sort((a, b) => a - b).map((s) => (cx0 + s * SLICE).toFixed(2)).join(' ')} → tyre x ${Math.min(xOut, xIn).toFixed(3)}..${Math.max(xOut, xIn).toFixed(3)}`)
    return { centre: [(xOut + xIn) / 2, yc, cz], radius, width: Math.abs(xOut - xIn) + SLICE }
  })
  return { ground, wheels }
}

/** Move every triangle inside a wheel's cylinder (minus the inboard hub region where suspension arms enter) into that corner. */
function captureWheels(wheels) {
  const EPS = 0.02
  for (const p of prims) {
    const pos = p.prim.getAttribute('POSITION').getArray()
    const idx = p.prim.getIndices()?.getArray() ?? null
    const triCount = idx ? idx.length / 3 : pos.length / 9
    const buckets = [[], [], [], []], rest = []
    const inside = (v, w) => {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]
      const dx = x - w.centre[0]
      if (Math.abs(dx) > w.width / 2 + EPS) return false
      const rad = Math.hypot(y - w.centre[1], z - w.centre[2])
      if (rad > w.radius + EPS) return false
      const inboard = w.centre[0] < 0 ? dx > w.width / 4 : dx < -w.width / 4
      return !(rad < w.radius * 0.35 && inboard)
    }
    for (let t = 0; t < triCount; t++) {
      let hit = -1
      for (let i = 0; i < 4 && hit < 0; i++) {
        let all = true
        for (let k = 0; k < 3 && all; k++) all = inside(idx ? idx[t * 3 + k] : t * 3 + k, wheels[i])
        if (all) hit = i
      }
      ;(hit >= 0 ? buckets[hit] : rest).push(t)
    }
    if (buckets.every((b) => !b.length)) continue
    buckets.forEach((b, i) => { if (b.length) cornerParts[i].push({ prim: subsetPrimitive(p.prim, b, idx), cls: 'tyre' }) })
    const remainder = subsetPrimitive(p.prim, rest, idx)
    p.prim.dispose()
    p.prim = remainder
  }
}

const cornerParts = [[], [], [], []] // { prim, cls }
let wheelInfo
if (cfg.wheelDetect === 'contact') {
  const { ground, wheels } = detectWheelsByContact()
  captureWheels(wheels)
  const xMid = wheels.reduce((s, w) => s + w.centre[0], 0) / 4
  const zMid = wheels.reduce((s, w) => s + w.centre[2], 0) / 4
  const shift = translate(-xMid, -ground, -zMid)
  for (const p of prims) transformPrimitive(p.prim, shift)
  for (const parts of cornerParts) for (const part of parts) transformPrimitive(part.prim, shift)
  wheelInfo = wheels.map((w) => ({ centre: [w.centre[0] - xMid, w.centre[1] - ground, w.centre[2] - zMid], radius: w.radius, width: w.width }))
  console.log('captured triangles per corner:', cornerParts.map((parts) => parts.reduce((s, part) => s + (part.prim.getIndices()?.getCount() ?? 0) / 3, 0)).join(' / '))
  console.log('contact-detected wheels:', wheelInfo.map((w) => `(${w.centre.map((v) => v.toFixed(3)).join(', ')}) r ${w.radius.toFixed(3)} w ${w.width.toFixed(3)}`).join(' '))
} else {
  // Shift so the tyres touch y = 0 and the wheelbase midpoint is the origin.
  const tyreBox = emptyBox()
  for (const p of prims) if (p.cls === 'tyre') { const b = primBounds(p.prim); growBox(tyreBox, b.lo); growBox(tyreBox, b.hi) }
  if (!Number.isFinite(tyreBox.lo[0])) throw new Error('no primitives classified as tyre — check the rules (or set wheelDetect: "contact")')
  const centre = boxCentre(tyreBox)
  const shift = translate(-centre[0], -tyreBox.lo[1], -centre[2])
  for (const p of prims) transformPrimitive(p.prim, shift)
  for (const p of prims) {
    if (p.cls !== 'tyre' && p.cls !== 'spin' && p.cls !== 'steer') continue
    splitCorners(p.prim).forEach((half, i) => { if (half) cornerParts[i].push({ prim: half, cls: p.cls }) })
    p.prim.dispose()
  }
  wheelInfo = cornerParts.map((parts, i) => {
    const box = emptyBox()
    for (const part of parts) if (part.cls === 'tyre') { const b = primBounds(part.prim); growBox(box, b.lo); growBox(box, b.hi) }
    if (!Number.isFinite(box.lo[0])) throw new Error(`corner ${i} has no tyre triangles`)
    // The axle centre and radius come from the y/z extent; the x extent (width
    // and lateral centre) only from vertices out near the tread, so an axle
    // rod or driveshaft baked into the same mesh cannot drag the wheel inboard.
    const [, yc, zc] = boxCentre(box)
    const radius = (box.hi[1] - box.lo[1]) / 2
    const outer = emptyBox()
    for (const part of parts) {
      if (part.cls !== 'tyre') continue
      const pos = part.prim.getAttribute('POSITION').getArray()
      for (let k = 0; k < pos.length; k += 3) if (Math.hypot(pos[k + 1] - yc, pos[k + 2] - zc) > radius * 0.6) growBox(outer, [pos[k], pos[k + 1], pos[k + 2]])
    }
    return { centre: [(outer.lo[0] + outer.hi[0]) / 2, yc, zc], radius, width: outer.hi[0] - outer.lo[0] }
  })
}

// Report boxes (final frame) for named parts, before meshes are rebuilt.
const report = []
for (const p of prims) if (cfg.report.some((re) => re.test(p.pathStr) || re.test(p.matName))) { const b = primBounds(p.prim); report.push(`${(p.pathStr.split('/').slice(-2).join('/') + ' [' + p.matName + ']').padEnd(52)} (${fmt(b.lo)}) .. (${fmt(b.hi)})`) }

// --- build the target hierarchy ------------------------------------------------
for (const child of scene.listChildren()) scene.removeChild(child) // old roots are pruned later
const mkNode = (name, parent) => { const n = doc.createNode(name); parent.addChild(n); return n }
const bodyNode = mkNode('body', scene)
const cockpitNode = mkNode('cockpit_hidden', bodyNode)
const brakeNode = mkNode('light_brake', bodyNode)
const groups = new Map() // target node → primitives
const addPrim = (target, prim) => { if (!groups.has(target)) groups.set(target, []); groups.get(target).push(prim) }
for (let i = 0; i < 4; i++) {
  const c = wheelInfo[i].centre
  const hub = mkNode(`wheel_${i}`, scene).setTranslation(c)
  const spin = mkNode(`wheel_${i}_spin`, hub)
  for (const part of cornerParts[i]) {
    transformPrimitive(part.prim, translate(-c[0], -c[1], -c[2]))
    addPrim(part.cls === 'steer' ? hub : spin, part.prim)
  }
}
for (const p of prims) {
  if (p.cls === 'cockpit') addPrim(cockpitNode, p.prim)
  else if (p.cls === 'brake') addPrim(brakeNode, p.prim)
  else if (p.cls === 'body') addPrim(bodyNode, p.prim)
}
// Detach the source meshes/nodes (their primitives now live in the new meshes).
for (const mesh of root.listMeshes()) mesh.dispose()

// Join primitives per material inside each target node → one mesh per node.
let drawCalls = 0, tris = 0
for (const [target, list] of groups) {
  const byMat = new Map()
  for (const p of list) { const m = p.getMaterial(); if (!byMat.has(m)) byMat.set(m, []); byMat.get(m).push(p) }
  const mesh = doc.createMesh(target.getName())
  for (const same of byMat.values()) {
    const joined = same.length > 1 ? joinPrimitives(same) : same[0]
    if (same.length > 1) for (const p of same) p.dispose()
    mesh.addPrimitive(joined)
    drawCalls++
    tris += (joined.getIndices()?.getCount() ?? joined.getAttribute('POSITION').getCount()) / 3
  }
  target.setMesh(mesh)
}

// --- materials ------------------------------------------------------------------
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
  for (const o of cfg.materials ?? []) {
    if (!o.match.test(mat.getName())) continue
    if (o.metallic !== undefined) mat.setMetallicFactor(o.metallic)
    if (o.roughness !== undefined) mat.setRoughnessFactor(o.roughness)
    if (o.clearcoat !== undefined) {
      const ext = doc.createExtension(ALL_EXTENSIONS.find((e) => e.EXTENSION_NAME === 'KHR_materials_clearcoat'))
      mat.setExtension('KHR_materials_clearcoat', ext.createClearcoat().setClearcoatFactor(o.clearcoat).setClearcoatRoughnessFactor(o.clearcoatRoughness ?? 0.2))
    }
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
if (cfg.decimate) {
  await MeshoptSimplifier.ready
  await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: cfg.decimate, error: 0.001 }))
  tris = 0
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3
  console.log(`decimated to ${Math.round(tris / 1000)}k tris (ratio ${cfg.decimate})`)
}
await doc.transform(dedup(), prune(), weld(), draco({ method: 'edgebreaker', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }))
fs.mkdirSync(path.dirname(cfg.output), { recursive: true })
await io.write(cfg.output, doc)

// --- report ----------------------------------------------------------------------
const bodyBox = emptyBox()
for (const p of bodyNode.getMesh().listPrimitives()) { const b = primBounds(p); growBox(bodyBox, b.lo); growBox(bodyBox, b.hi) }
const [fl, fr, rl, rr] = wheelInfo.map((w) => w.centre)
console.log(`\n${cfg.output}: ${(fs.statSync(cfg.output).size / 1048576).toFixed(2)} MB, ${drawCalls} draw calls, ${Math.round(tris / 1000)}k tris, ${root.listTextures().length} textures, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
console.log('wheel centres FL/FR/RL/RR:', [fl, fr, rl, rr].map((c) => `(${c.map((v) => v.toFixed(3)).join(', ')})`).join(' '))
console.log(`wheelbase ${(fl[2] - rl[2]).toFixed(3)}  track front ${(fr[0] - fl[0]).toFixed(3)} rear ${(rr[0] - rl[0]).toFixed(3)}  radius ${wheelInfo.map((w) => w.radius.toFixed(3)).join('/')}  width ${wheelInfo.map((w) => w.width.toFixed(3)).join('/')}`)
console.log(`body bounds (${fmt(bodyBox.lo)}) .. (${fmt(bodyBox.hi)}) → length ${(bodyBox.hi[2] - bodyBox.lo[2]).toFixed(2)} width ${(bodyBox.hi[0] - bodyBox.lo[0]).toFixed(2)} height ${bodyBox.hi[1].toFixed(2)}`)
console.log(`overhang front ${(bodyBox.hi[2] - fl[2]).toFixed(2)} rear ${(rl[2] - bodyBox.lo[2]).toFixed(2)} (front should be the longer one; otherwise flip yawDeg)`)
console.log('reported parts (final frame):\n  ' + report.join('\n  '))
