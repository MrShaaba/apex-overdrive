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
      { cls: 'cockpit', path: /Steering|Cube\.02[89]/ }, // wheel, column and the two wheel-mount blocks
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
  // --- road cars: wheels found from the ground-contact patches (see sf23) ---
  countach: {
    source: 'assets-src/models/roadcars/2021_lamborghini_countach_lpi_800-4/scene.gltf',
    output: 'public/assets/models/cars/countach.glb',
    credit: '2021 Lamborghini Countach LPI 800-4 by Lexyc16 (sketchfab.com/Lexyc16), CC-BY-NC 4.0',
    scale: 0.495, // 9.8 m long as exported; the real car is 4.87 m
    yawDeg: 180,
    rules: [],
    wheelDetect: 'contact',
    decimate: 0.5,
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  revuelto: {
    source: 'assets-src/models/roadcars/lamborghini_revuelto/scene.gltf',
    output: 'public/assets/models/cars/revuelto.glb',
    credit: 'Lamborghini Revuelto by Outlaw Games (sketchfab.com/Outlaw_Games), CC-BY-NC 4.0',
    scale: 1,
    yawDeg: 90, // exported with the length along +X
    rules: [],
    wheelDetect: 'contact',
    wheelRadius: [0.35, 0.37], // real tyre radii (m): the low-poly tread ring loses the density contest to the rims
    decimate: 0.5,
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  huracan: {
    source: 'assets-src/models/roadcars/huracan_eagletm/scene.gltf',
    output: 'public/assets/models/cars/huracan.glb',
    credit: 'Huracan EAGLE by SDC PERFORMANCE (sketchfab.com/3Duae), CC-BY-NC 4.0',
    scale: 0.865, // 5.26 m long as exported; the GT3 car is 4.55 m
    yawDeg: 180,
    rules: [],
    wheelDetect: 'contact',
    decimate: 0.4,
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  charger: {
    source: 'assets-src/models/roadcars/dodge_charger_fast__furious_8/scene.gltf',
    output: 'public/assets/models/cars/charger.glb',
    credit: 'Dodge Charger Fast & Furious 8 by VTX (sketchfab.com/VTX_car), CC-BY-NC-SA 4.0',
    scale: 1,
    yawDeg: 180, // the dashboard sits at -Z
    rules: [],
    wheelDetect: 'contact',
    wheelRadius: [0.37, 0.37], // real tyre radii (m): the low-poly tread ring loses the density contest to the rims
    decimate: 0.6,
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  challenger: {
    source: 'assets-src/models/roadcars/dodge_challenger_modified_truck/scene.gltf',
    output: 'public/assets/models/cars/challenger.glb',
    credit: 'dodge challenger modified truck by carmodifier (sketchfab.com/carmodifier), CC-BY-NC 4.0',
    scale: 0.59, // 8.5 m long as exported; a Challenger is 5.0 m
    yawDeg: 180, // the grille faces -Z as exported
    rules: [],
    wheelDetect: 'contact',
    decimate: 0.06, // 4.2 M tris of bolts and engine parts
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  enforcer: {
    source: 'assets-src/models/roadcars/the_terminus_enforcer/scene.gltf',
    output: 'public/assets/models/cars/enforcer.glb',
    credit: 'The Terminus Enforcer by TooManyDemons (sketchfab.com/toomanydemons), CC-BY 4.0',
    scale: 0.01, // centimetres
    yawDeg: 0,
    rules: [],
    wheelDetect: 'contact',
    wheelRadius: [0.7, 0.7], // real tyre radii (m): the low-poly tread ring loses the density contest to the rims
    decimate: 0.6,
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  // Cockpit prop: no wheels, centred on its steering axis (CockpitWheel spins it about z).
  wheel: {
    kind: 'prop',
    source: 'assets-src/models/cockpit/mclaren_steering_wheel/scene.gltf',
    output: 'public/assets/models/cockpit/mclaren_wheel.glb',
    credit: 'McLaren Formula 1 Steering Wheel by dhimasdc9 (sketchfab.com/dhimasdc9), CC-BY 4.0',
    scale: 0.07, // 4.15 m wide as exported; a real wheel is ~0.29 m
    yawDeg: 0,
    pivot: [0, -0.43, 0], // quick-release hub centre, source units
    rules: [],
    decimate: 0.25, // 332k tris → ~83k
    report: [/screen_0/, /glass_0/, /connector_0/],
    textures: { color: 1024, normal: 1024, other: 1024 },
  },
  lotus72d: {
    source: 'assets-src/models/cars/1972_lotus_72d/scene.gltf',
    output: 'public/assets/models/cars/lotus72d.glb',
    credit: '1972 Lotus 72D by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 0.24, // 19.3 m long as exported; wheelbase 2.36 → 2.54 m real at this scale
    yawDeg: 0,
    rules: [{ cls: 'tyre', path: /wheel_(fl|fr|rl|rr)/ }], // whole wheel per corner
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  jaguar: {
    source: 'assets-src/models/cars/formula_e__jaguar_i_type-4/scene.gltf',
    output: 'public/assets/models/cars/jaguar.glb',
    credit: 'Formula E [Jaguar I Type-4] by 3dblenderlol (sketchfab.com/3dblenderlol), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    rules: [
      { cls: 'tyre', path: /(front|rear)-(left|right)/ },
      { cls: 'cockpit', path: /steering_/ },
    ],
    decimate: 0.6,
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  w11: {
    source: 'assets-src/models/cars/mercedec_f1_2020/scene.gltf',
    output: 'public/assets/models/cars/w11.glb',
    credit: 'Mercedec F1 2020 by Kevin Love SketchFab (sketchfab.com/Tyler_Kevin), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    rules: [
      { cls: 'tyre', material: /^Tyre$/ },
      { cls: 'spin', material: /wheel_hub|RIM_BLUR/ },
      { cls: 'cockpit', material: /steeringwheel/ },
      { cls: 'brake', material: /REAR_LIGHT|2020_light/ },
    ],
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  w14: {
    source: 'assets-src/models/cars/mercedes-amg_w14_formula_one_2023/scene.gltf',
    output: 'public/assets/models/cars/w14.glb',
    credit: 'Mercedes-AMG W14 Formula One 2023 by VTX (sketchfab.com/VTX_car), CC-BY-NC-SA 4.0',
    scale: 0.79, // wheelbase 3.43 m at 0.75; the real car is 3.6 m
    yawDeg: 0,
    rules: [{ cls: 'brake', material: /REAR_LIGHT/ }],
    wheelDetect: 'contact',
    wheelRadius: [0.36, 0.36], // the contact test read the rear rims, not the tyres
    decimate: 0.6,
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  w14free: {
    source: 'assets-src/models/cars/mercedes_f1_w14_free/scene.gltf',
    output: 'public/assets/models/cars/w14free.glb',
    credit: 'Mercedes F1 W14 [FREE!!] by 3dblenderlol (sketchfab.com/3dblenderlol), CC-BY 4.0',
    scale: 1.08, // 1.85 m wide as exported; the real car is 2.0 m
    yawDeg: 0,
    rules: [
      { cls: 'tyre', path: /\/(FL|FR|RL|RR|front (left|right)|rear (left|right))_\d+\// }, // one node per corner: tyre + rim
      { cls: 'cockpit', path: /steering_24/ },
    ],
    decimate: 0.7,
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  w201: {
    source: 'assets-src/models/roadcars/1982_mercedes_w201/scene.gltf',
    output: 'public/assets/models/cars/w201.glb',
    credit: '1982 Mercedes W201 by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    rules: [
      { cls: 'tyre', material: /^EXT_Tyre/ },
      { cls: 'spin', material: /^EXT_Rim|^EXT_Brake_Disc/ },
    ],
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  gtrfina: {
    source: 'assets-src/models/roadcars/1995_mclaren_f1_gtr_fina/scene.gltf',
    output: 'public/assets/models/cars/gtrfina.glb',
    credit: '1995 McLaren F1 GTR Fina by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    rules: [
      { cls: 'tyre', material: /^Tyre/ },
      { cls: 'spin', material: /^Rim|^Brake_Disk/ },
      { cls: 'brake', material: /^Rear_Lights/ },
    ],
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  gtrgulf: {
    source: 'assets-src/models/roadcars/1995_mclaren_f1_gtr_gulf/scene.gltf',
    output: 'public/assets/models/cars/gtrgulf.glb',
    credit: '1995 McLaren F1 GTR Gulf by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    rules: [
      { cls: 'tyre', material: /^Tyre/ },
      { cls: 'spin', material: /^Rim|^Brake_Disk/ },
      { cls: 'brake', material: /^Rear_Lights/ },
    ],
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  longtail: {
    source: 'assets-src/models/roadcars/1997_mclaren_f1_gtr_longtail/scene.gltf',
    output: 'public/assets/models/cars/longtail.glb',
    credit: '1997 McLaren F1 GTR Longtail by Dave Bored SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 0.217, // 22.7 m long as exported; the real car is 4.93 m
    yawDeg: 0,
    rules: [],
    wheelDetect: 'contact',
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  clkdtm: {
    source: 'assets-src/models/roadcars/2002_mercedes_clk_dtm_d2/scene.gltf',
    output: 'public/assets/models/cars/clkdtm.glb',
    credit: '2002 Mercedes CLK DTM D2 by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    rules: [
      { cls: 'tyre', material: /^tire/ },
      { cls: 'spin', material: /^rim/ },
      { cls: 'brake', material: /^rearlight|^brakes/ },
    ],
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  ccoupedtm: {
    source: 'assets-src/models/roadcars/2018_mercedes_c-coupe_dtm/scene.gltf',
    output: 'public/assets/models/cars/ccoupedtm.glb',
    credit: '2018 Mercedes C-Coupé DTM by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 0,
    rules: [
      { cls: 'tyre', material: /^EXT_Tire/ },
      { cls: 'spin', material: /^EXT_Rim|^EXT_Brakes/ },
      { cls: 'cockpit', material: /^INT_Steer/ },
      { cls: 'brake', material: /^EXT_Lights_A/ },
    ],
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  sls: {
    source: 'assets-src/models/roadcars/mercedes_sls_safety_car/scene.gltf',
    output: 'public/assets/models/cars/sls.glb',
    credit: 'Mercedes SLS Safety Car by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1,
    yawDeg: 180, // the long bonnet sat at -Z
    rules: [],
    wheelDetect: 'contact',
    wheelRadius: [0.34, 0.35], // the contact test grabbed the rear arches
    decimate: 0.7,
    report: [],
    textures: { color: 2048, normal: 1024, other: 1024 },
  },
  amgone: {
    source: 'assets-src/models/roadcars/transparency_mercedes_amg_one/scene.gltf',
    output: 'public/assets/models/cars/amgone.glb',
    credit: 'Transparency Mercedes AMG One by Dave Love SketchFab (sketchfab.com/Tyler_Dave), CC-BY 4.0',
    scale: 1.09, // wheelbase 2.50 m as exported; the real car is 2.72 m
    yawDeg: 0,
    rules: [{ cls: 'tyre', material: /amgprojone_tire/ }],
    wheelDetect: 'contact',
    wheelRadius: [0.35, 0.36],
    decimate: 0.5,
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

const [carId, ...flags] = process.argv.slice(2) // car id or prop id
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
  // Overall footprint → quadrants (the lowest points of each quadrant are that
  // corner's contact patch, so a model that sits a little nose-down still works).
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const a of arrays) for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a[i + k]); hi[k] = Math.max(hi[k], a[i + k]) }
  const cxAll = (lo[0] + hi[0]) / 2, czAll = (lo[2] + hi[2]) / 2
  const quad = (x, z) => (z > czAll ? 0 : 2) + (x < cxAll ? 0 : 1)
  const minY = [Infinity, Infinity, Infinity, Infinity]
  for (const a of arrays) for (let i = 0; i < a.length; i += 3) { const q = quad(a[i], a[i + 2]); minY[q] = Math.min(minY[q], a[i + 1]) }
  const CONTACT = 0.03
  const clusters = [[], [], [], []]
  for (const a of arrays) for (let i = 0; i < a.length; i += 3) { const q = quad(a[i], a[i + 2]); if (a[i + 1] < minY[q] + CONTACT) clusters[q].push([a[i], a[i + 1], a[i + 2]]) }
  const BINS = 24, SLICE = 0.01
  const wheels = clusters.map((c, i) => {
    if (!c.length) throw new Error(`no ground contact found for corner ${i}`)
    const cx0 = c.reduce((s, v) => s + v[0], 0) / c.length
    const cz = c.reduce((s, v) => s + v[2], 0) / c.length
    const ground = minY[i]
    // Vertices near this corner (any height): the tyre lives within ~1.2 m of the patch.
    const near = []
    for (const a of arrays) for (let k = 0; k < a.length; k += 3) if (Math.abs(a[k] - cx0) < 0.6 && Math.abs(a[k + 2] - cz) < 1.2) near.push(a[k], a[k + 1], a[k + 2])
    // Radius: the largest ring around the axle that goes (almost) all the way
    // round. Wheel arches are open at the bottom, so they never qualify.
    // Every full ring centred on the axle is a candidate (tread, rim lip,
    // sometimes a wheel-well liner); the densest one is normally the tread.
    // Low-poly tyres next to high-poly rims lose that contest, so a config
    // may pin the real tyre radius instead (`wheelRadius: [front, rear]`).
    let radius = cfg.wheelRadius ? cfg.wheelRadius[i < 2 ? 0 : 1] : 0, bestScore = 0
    const candidates = []
    if (!radius) {
      for (let r = 1.0; r >= 0.15; r -= 0.005) {
        const yc = ground + r
        const bins = new Set()
        let count = 0
        for (let k = 0; k < near.length; k += 3) {
          if (Math.abs(near[k] - cx0) > 0.35) continue
          const dy = near[k + 1] - yc, dz = near[k + 2] - cz
          const rad = Math.hypot(dy, dz)
          if (Math.abs(rad - r) > r * 0.03) continue
          bins.add(Math.floor(((Math.atan2(dz, dy) + Math.PI) / (2 * Math.PI)) * BINS) % BINS)
          count++
        }
        if (bins.size >= BINS * 0.75) { candidates.push({ r, coverage: bins.size / BINS, count }); if (count > bestScore) { bestScore = count; radius = r } }
      }
      if (process.env.RING_DEBUG) console.log(`    corner ${i} rings:`, candidates.sort((a, b) => b.count - a.count).slice(0, 8).map((c) => `${c.r.toFixed(3)}:${c.count}@${Math.round(c.coverage * 100)}%`).join(' '))
    }
    if (!radius) throw new Error(`corner ${i}: no full tread ring found around (${cx0.toFixed(2)}, ${cz.toFixed(2)})`)
    const yc = ground + radius
    // Width from the contact patch: the lowest 3 cm of the tyre is exactly the
    // tread on the ground, which neither fenders, liners nor the floor reach.
    const pxs = c.map((v) => v[0]).sort((a, b) => a - b)
    const xIn0 = pxs[Math.floor(pxs.length * 0.02)], xOut0 = pxs[Math.ceil(pxs.length * 0.98) - 1]
    const pad = (xOut0 - xIn0) * 0.04
    const xIn = xIn0 - pad, xOut = xOut0 + pad
    void SLICE
    console.log(`  corner ${i}: contact (${cx0.toFixed(2)}, ${cz.toFixed(2)}) r ${radius.toFixed(3)} (${bestScore} tread verts) patch x ${xIn.toFixed(3)}..${xOut.toFixed(3)}`)
    return { centre: [(xOut + xIn) / 2, yc, cz], radius, width: xOut - xIn, ground }
  })
  // Two-wheelers: both "corners" of an axle land on the same centred wheel.
  for (const [a, b] of [[0, 1], [2, 3]]) {
    if (Math.abs(wheels[a].centre[0] - wheels[b].centre[0]) < 0.3) {
      const w = wheels[a], v = wheels[b]
      const xMin = Math.min(w.centre[0] - w.width / 2, v.centre[0] - v.width / 2), xMax = Math.max(w.centre[0] + w.width / 2, v.centre[0] + v.width / 2)
      wheels[a] = { ...w, centre: [(xMin + xMax) / 2, w.centre[1], (w.centre[2] + v.centre[2]) / 2], width: xMax - xMin, radius: Math.max(w.radius, v.radius) }
      wheels[b] = { ...wheels[a], empty: true }
      console.log(`  corners ${a}/${b} share one centred wheel (two-wheeler): corner ${b} left empty`)
    }
  }
  return { ground: Math.min(...wheels.map((w) => w.ground)), wheels }
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
        if (wheels[i].empty) continue
        let all = true
        for (let k = 0; k < 3 && all; k++) all = inside(idx ? idx[t * 3 + k] : t * 3 + k, wheels[i])
        if (all) hit = i
      }
      ;(hit >= 0 ? buckets[hit] : rest).push(t)
    }
    if (buckets.every((b) => !b.length)) continue
    buckets.forEach((b, i) => { if (b.length) cornerParts[i].push({ prim: subsetPrimitive(p.prim, b, idx), cls: 'tyre' }) })
    const remainder = rest.length ? subsetPrimitive(p.prim, rest, idx) : null
    p.prim.dispose()
    p.prim = remainder
  }
}

const cornerParts = [[], [], [], []] // { prim, cls }
let wheelInfo
const isProp = cfg.kind === 'prop'
if (isProp) {
  // No wheels: just move the pivot to the origin.
  const shift = translate(-cfg.pivot[0] * cfg.scale, -cfg.pivot[1] * cfg.scale, -cfg.pivot[2] * cfg.scale)
  for (const p of prims) transformPrimitive(p.prim, shift)
  wheelInfo = []
} else if (cfg.wheelDetect === 'contact') {
  const { ground, wheels } = detectWheelsByContact()
  captureWheels(wheels)
  for (let i = prims.length - 1; i >= 0; i--) {
    const pr = prims[i].prim
    const bad = !pr || Array.from(pr.getAttribute('POSITION').getArray()).some((v) => !Number.isFinite(v))
    if (bad) { pr?.dispose(); prims.splice(i, 1) } // fully captured meshes, or junk with NaN vertices
  }
  const xMid = wheels.reduce((s, w) => s + w.centre[0], 0) / 4
  const zMid = wheels.reduce((s, w) => s + w.centre[2], 0) / 4
  void ground
  const shift = translate(-xMid, -ground, -zMid)
  for (const p of prims) transformPrimitive(p.prim, shift)
  for (const parts of cornerParts) for (const part of parts) transformPrimitive(part.prim, shift)
  wheelInfo = wheels.map((w) => ({ centre: [w.centre[0] - xMid, w.centre[1] - ground, w.centre[2] - zMid], radius: w.radius, width: w.width, empty: !!w.empty }))
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
const bodyNode = mkNode(isProp ? 'prop' : 'body', scene)
const cockpitNode = mkNode('cockpit_hidden', bodyNode)
const brakeNode = mkNode('light_brake', bodyNode)
const groups = new Map() // target node → primitives
const addPrim = (target, prim) => { if (!groups.has(target)) groups.set(target, []); groups.get(target).push(prim) }
for (let i = 0; i < (isProp ? 0 : 4); i++) {
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
  // Join only what joinPrimitives accepts: same material, mode and vertex layout.
  const byMat = new Map()
  for (const p of list) { const key = [p.getMaterial()?.getName(), p.getMode(), p.listSemantics().join(','), p.getIndices() ? 'i' : 'n'].join('|'); if (!byMat.has(key)) byMat.set(key, []); byMat.get(key).push(p) }
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
await doc.transform(dedup(), prune({ keepLeaves: true }), weld(), draco({ method: 'edgebreaker', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }))
fs.mkdirSync(path.dirname(cfg.output), { recursive: true })
await io.write(cfg.output, doc)

// --- report ----------------------------------------------------------------------
const bodyBox = emptyBox()
for (const p of bodyNode.getMesh().listPrimitives()) {
  const b = primBounds(p)
  if (!Number.isFinite(b.lo[0]) || Number.isNaN(b.lo[0])) { console.log(`  body primitive ${p.getMaterial()?.getName()} has ${p.getAttribute('POSITION').getCount()} verts and non-finite bounds`); continue }
  growBox(bodyBox, b.lo); growBox(bodyBox, b.hi)
}
console.log(`\n${cfg.output}: ${(fs.statSync(cfg.output).size / 1048576).toFixed(2)} MB, ${drawCalls} draw calls, ${Math.round(tris / 1000)}k tris, ${root.listTextures().length} textures, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
if (isProp) {
  console.log(`prop bounds (${fmt(bodyBox.lo)}) .. (${fmt(bodyBox.hi)}) → size ${fmt(bodyBox.hi.map((v, i) => v - bodyBox.lo[i]))}`)
  console.log('reported parts (final frame):\n  ' + report.join('\n  '))
  process.exit(0)
}
const [fl, fr, rl, rr] = wheelInfo.map((w) => w.centre)
console.log('wheel centres FL/FR/RL/RR:', [fl, fr, rl, rr].map((c) => `(${c.map((v) => v.toFixed(3)).join(', ')})`).join(' '))
console.log(`wheelbase ${(fl[2] - rl[2]).toFixed(3)}  track front ${(fr[0] - fl[0]).toFixed(3)} rear ${(rr[0] - rl[0]).toFixed(3)}  radius ${wheelInfo.map((w) => w.radius.toFixed(3)).join('/')}  width ${wheelInfo.map((w) => w.width.toFixed(3)).join('/')}`)
console.log(`body bounds (${fmt(bodyBox.lo)}) .. (${fmt(bodyBox.hi)}) → length ${(bodyBox.hi[2] - bodyBox.lo[2]).toFixed(2)} width ${(bodyBox.hi[0] - bodyBox.lo[0]).toFixed(2)} height ${bodyBox.hi[1].toFixed(2)}`)
console.log(`overhang front ${(bodyBox.hi[2] - fl[2]).toFixed(2)} rear ${(rl[2] - bodyBox.lo[2]).toFixed(2)} (front should be the longer one; otherwise flip yawDeg)`)
console.log('reported parts (final frame):\n  ' + report.join('\n  '))
