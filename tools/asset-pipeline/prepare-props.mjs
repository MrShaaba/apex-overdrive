#!/usr/bin/env node
/**
 * Turns a scenery scene (assets-src/models/environments/<name>/scene.gltf)
 * into a prop library: public/assets/models/props/<id>.glb with one node per
 * prop, each centred on its footprint with its base at y = 0 and named by
 * kind (`building_3`, `shop_1`, `bollard_0`, `railing_2`, ...), so
 * tracks/TrackProps.ts can scatter instances of them along any circuit.
 *
 *  1. bakes transforms and groups the scene's top-level objects by footprint
 *     overlap (a shop front and the floors stacked on it become one prop);
 *  2. drops flat ground planes; classifies the rest by size — tall blocks are
 *     buildings, room-sized boxes are shops/kiosks, long thin pieces are
 *     railings, knee-high sticks are bollards, huge thin sheets are
 *     billboards;
 *  3. joins primitives per material, encodes textures to KTX2 and
 *     Draco-compresses the geometry.
 *
 * Usage: node tools/asset-pipeline/prepare-props.mjs <id> [--skip-textures]
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

const LIBS = {
  city: {
    source: 'assets-src/models/environments/street_city_7/scene.gltf',
    output: 'public/assets/models/props/city.glb',
    credit: 'street city (7) for games FREE by dasy444 (sketchfab.com/dasy444), Sketchfab Standard licence',
    scale: 1,
    /** Top-level container whose children are the individual objects. */
    container: /RootNode$/,
    textures: { color: 1024, normal: 1024, other: 1024 },
  },
}

const [libId, ...flags] = process.argv.slice(2)
const cfg = LIBS[libId]
if (!cfg) {
  console.error(`unknown library "${libId}". Known: ${Object.keys(LIBS).join(', ')}`)
  process.exit(2)
}
const skipTextures = flags.includes('--skip-textures')
const t0 = Date.now()
const mul = (a, b) => { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o }
const scaleM = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
const emptyBox = () => ({ lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] })
const growBox = (box, p) => { for (let i = 0; i < 3; i++) { box.lo[i] = Math.min(box.lo[i], p[i]); box.hi[i] = Math.max(box.hi[i], p[i]) } }
const primBounds = (prim) => { const pos = prim.getAttribute('POSITION').getArray(); const box = emptyBox(); for (let i = 0; i < pos.length; i += 3) growBox(box, [pos[i], pos[i + 1], pos[i + 2]]); return box }

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.encoder': await draco3d.createEncoderModule() })
const doc = await io.read(cfg.source)
const root = doc.getRoot()
const scene = root.listScenes()[0]

// --- objects = children of the container, baked to world space ------------------
let container = null
scene.traverse((n) => { if (!container && cfg.container.test(n.getName())) container = n })
if (!container) throw new Error('container node not found')
const objects = [] // { name, prims: [prim], box }
for (const obj of container.listChildren()) {
  const prims = []
  obj.traverse((n) => { const mesh = n.getMesh(); if (!mesh) return; const world = mul(scaleM(cfg.scale), Array.from(n.getWorldMatrix())); for (const p of mesh.listPrimitives()) { transformPrimitive(p, world); prims.push(p) } })
  if (!prims.length) continue
  const box = emptyBox()
  for (const p of prims) { const b = primBounds(p); growBox(box, b.lo); growBox(box, b.hi) }
  objects.push({ name: obj.getName(), prims, box })
}
console.log(`${objects.length} objects`)

// --- drop ground sheets, cluster the rest by footprint overlap -----------------
const size = (b) => b.hi.map((v, i) => v - b.lo[i])
const isGround = (o) => { const s = size(o.box); return s[1] < 0.7 && s[0] * s[2] > 60 }
const parts = objects.filter((o) => !isGround(o))
const overlap = (a, b) => {
  const ax = Math.min(a.hi[0], b.hi[0]) - Math.max(a.lo[0], b.lo[0]), az = Math.min(a.hi[2], b.hi[2]) - Math.max(a.lo[2], b.lo[2])
  if (ax <= 0 || az <= 0) return 0
  const inter = ax * az
  const areaA = (a.hi[0] - a.lo[0]) * (a.hi[2] - a.lo[2]), areaB = (b.hi[0] - b.lo[0]) * (b.hi[2] - b.lo[2])
  return inter / Math.min(areaA, areaB)
}
const parent = parts.map((_, i) => i)
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (overlap(parts[i].box, parts[j].box) > 0.5) parent[find(i)] = find(j)
const clusters = new Map()
parts.forEach((p, i) => { const r = find(i); (clusters.get(r) ?? clusters.set(r, []).get(r)).push(p) })
const props = []
for (const members of clusters.values()) {
  const box = emptyBox()
  for (const m of members) { growBox(box, m.box.lo); growBox(box, m.box.hi) }
  const [w, h, d] = size(box)
  const long = Math.max(w, d), short = Math.min(w, d)
  let kind
  if (h > 6) kind = long > 8 && h > 10 && short < 1.5 ? 'billboard' : 'building'
  else if (h < 1.3 && long > 4 && short < 1) kind = 'railing'
  else if (h < 1.3 && long < 1) kind = 'bollard'
  else if (h < 1.5) kind = 'post'
  else kind = 'shop'
  props.push({ kind, members, box, w, h, d })
}
const counts = {}
for (const p of props) counts[p.kind] = (counts[p.kind] || 0) + 1
console.log('props by kind:', JSON.stringify(counts), '| ground sheets dropped:', objects.length - parts.length)

// --- rebuild: one node per prop, footprint-centred, base at y = 0 --------------
for (const child of scene.listChildren()) scene.removeChild(child)
for (const mesh of root.listMeshes()) mesh.dispose()
const byKind = {}
let drawCalls = 0, tris = 0
const report = []
for (const p of props.sort((a, b) => a.kind.localeCompare(b.kind) || b.h - a.h)) {
  const n = (byKind[p.kind] = (byKind[p.kind] ?? 0))
  byKind[p.kind]++
  const node = doc.createNode(`${p.kind}_${n}`)
  scene.addChild(node)
  const cx = (p.box.lo[0] + p.box.hi[0]) / 2, cz = (p.box.lo[2] + p.box.hi[2]) / 2, base = p.box.lo[1]
  const shift = translate(-cx, -base, -cz)
  const list = p.members.flatMap((m) => m.prims)
  for (const prim of list) transformPrimitive(prim, shift)
  const byKey = new Map()
  for (const prim of list) { const k = [prim.getMaterial()?.getName(), prim.getMode(), prim.listSemantics().join(','), prim.getIndices() ? 'i' : 'n'].join('|'); (byKey.get(k) ?? byKey.set(k, []).get(k)).push(prim) }
  const mesh = doc.createMesh(node.getName())
  for (const same of byKey.values()) {
    const joined = same.length > 1 ? joinPrimitives(same) : same[0]
    if (same.length > 1) for (const q of same) q.dispose()
    mesh.addPrimitive(joined)
    drawCalls++
    tris += (joined.getIndices()?.getCount() ?? joined.getAttribute('POSITION').getCount()) / 3
  }
  node.setMesh(mesh)
  // Footprint + height in the node extras for the placer.
  node.setExtras({ w: +p.w.toFixed(2), h: +p.h.toFixed(2), d: +p.d.toFixed(2) })
  report.push(`${node.getName().padEnd(14)} ${p.w.toFixed(1)} × ${p.h.toFixed(1)} × ${p.d.toFixed(1)} m  (${p.members.map((m) => m.name).join(', ')})`)
}
root.getAsset().copyright = cfg.credit
root.getAsset().generator = 'apex prepare-props.mjs (glTF-Transform)'

// --- textures + compression --------------------------------------------------------
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
    tex.setImage(new Uint8Array(fs.readFileSync(ktx))).setMimeType('image/ktx2').setURI('')
    n++
  }
  doc.createExtension(KHRTextureBasisu).setRequired(true)
  fs.rmSync(tmp, { recursive: true, force: true })
}
await doc.transform(dedup(), prune({ keepLeaves: true, keepExtras: true }), weld(), draco({ method: 'edgebreaker', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }))
fs.mkdirSync(path.dirname(cfg.output), { recursive: true })
await io.write(cfg.output, doc)
console.log(`\n${cfg.output}: ${(fs.statSync(cfg.output).size / 1048576).toFixed(2)} MB, ${props.length} props, ${drawCalls} draw calls, ${Math.round(tris / 1000)}k tris, ${root.listTextures().length} textures, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
console.log(report.join('\n'))
