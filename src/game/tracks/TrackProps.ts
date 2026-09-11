/**
 * Themed scenery: trees, palms, rocks, buildings, containers, cranes, lamp
 * posts, neon signs, crowds, grandstands and water. Everything is instanced and
 * bucketed into spatial chunks so frustum culling and a distance cut-off
 * ("visibility rejection") work per chunk. Buildings and trees close to the
 * road get physics colliders; distant ones are purely visual.
 */

import * as THREE from 'three'
import type { PhysicsWorld } from '../physics/PhysicsWorld'
import { CollisionGroup, makeGroups } from '../physics/Surfaces'
import type { TextureFactory } from '../render/TextureFactory'
import { createRng, hashString, lerp } from '../core/MathUtils'
import type { TrackDefinition } from './TrackCatalog'
import type { TrackSpline } from './Spline'

export interface CrowdZone {
  position: THREE.Vector3
  radius: number
}

export interface PropsResult {
  root: THREE.Group
  crowdZones: CrowdZone[]
  lampPositions: THREE.Vector3[]
  updateVisibility(cameraPos: THREE.Vector3, drawDistance: number, time: number): void
  setNight(nightFactor: number): void
  dispose(): void
}

interface Chunk {
  center: THREE.Vector3
  meshes: THREE.Object3D[]
  radius: number
}

const CHUNK = 120
const PROP_GROUPS = makeGroups(CollisionGroup.PROP, CollisionGroup.ALL)

/** A prop from the licensed scenery library (public/assets/models/props/*.glb, built by prepare-props.mjs). */
interface LibraryProp {
  meshes: THREE.Mesh[]
  /** Footprint width / height / depth in metres, from the node extras. */
  w: number
  h: number
  d: number
}

/** Group the library's `<kind>_<n>` nodes by kind. */
export function indexPropLibrary(library: THREE.Group | null): Map<string, LibraryProp[]> {
  const kinds = new Map<string, LibraryProp[]>()
  if (!library) return kinds
  for (const node of library.children) {
    const kind = node.name.replace(/_\d+$/, '')
    const meshes: THREE.Mesh[] = []
    node.traverse((o) => { if (o instanceof THREE.Mesh) meshes.push(o) })
    if (!meshes.length) continue
    const ex = node.userData as { w?: number; h?: number; d?: number }
    const prop = { meshes, w: ex.w ?? 2, h: ex.h ?? 2, d: ex.d ?? 2 }
    ;(kinds.get(kind) ?? kinds.set(kind, []).get(kind)!).push(prop)
  }
  return kinds
}

export function buildProps(
  def: TrackDefinition,
  spline: TrackSpline,
  halfWidth: number,
  terrainHeight: (x: number, z: number) => number,
  textures: TextureFactory,
  physics: PhysicsWorld,
  density: number,
  bounds: THREE.Box3,
  shortcutClearance: (x: number, z: number) => number,
  library: THREE.Group | null = null,
): PropsResult {
  const root = new THREE.Group()
  root.name = 'props'
  const rng = createRng(hashString(def.id))
  const env = def.environment
  const chunks = new Map<string, Chunk>()
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = []
  const crowdZones: CrowdZone[] = []
  const lampPositions: THREE.Vector3[] = []
  const nightMaterials: THREE.MeshStandardMaterial[] = []
  const animated: { mesh: THREE.InstancedMesh; phases: Float32Array; base: THREE.Matrix4[] }[] = []
  const lib = indexPropLibrary(library)
  const pick = (kind: string): LibraryProp | null => { const list = lib.get(kind); return list && list.length ? list[Math.floor(rng() * list.length)] : null }

  /**
   * Instance library props: one InstancedMesh per (prop, mesh) per chunk.
   * Geometry and materials are the library's own (shared, not disposed here).
   */
  const placeLibrary = (placements: { prop: LibraryProp; matrix: THREE.Matrix4; position: THREE.Vector3 }[], cast = true) => {
    const groups = new Map<LibraryProp, Map<Chunk, THREE.Matrix4[]>>()
    for (const pl of placements) {
      const byChunk = groups.get(pl.prop) ?? groups.set(pl.prop, new Map()).get(pl.prop)!
      const c = chunkFor(pl.position)
      ;(byChunk.get(c) ?? byChunk.set(c, []).get(c)!).push(pl.matrix)
    }
    for (const [prop, byChunk] of groups) {
      for (const [chunk, mats] of byChunk) {
        for (const mesh of prop.meshes) {
          const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, mats.length)
          mats.forEach((m, i) => inst.setMatrixAt(i, m))
          inst.instanceMatrix.needsUpdate = true
          inst.castShadow = cast
          inst.receiveShadow = true
          root.add(inst)
          chunk.meshes.push(inst)
          chunk.radius = Math.max(chunk.radius, 160)
        }
      }
    }
  }

  const chunkFor = (p: THREE.Vector3): Chunk => {
    const key = `${Math.floor(p.x / CHUNK)},${Math.floor(p.z / CHUNK)}`
    let c = chunks.get(key)
    if (!c) {
      c = { center: new THREE.Vector3((Math.floor(p.x / CHUNK) + 0.5) * CHUNK, 0, (Math.floor(p.z / CHUNK) + 0.5) * CHUNK), meshes: [], radius: CHUNK * 0.75 }
      chunks.set(key, c)
    }
    return c
  }

  // Nearest spline sample in plan (x, z) only. The spline's own nearestIndex measures in
  // 3-D, so on a circuit with elevation a point at y = 0 read as "far from the road" next
  // to a section 100 m up — and trees got planted on the racing line at Alpine Ridge.
  const nearestInPlan = (x: number, z: number): number => {
    let best = 0, bestD = Infinity
    const samples = spline.samples
    for (let i = 0; i < samples.length; i += 2) {
      const dx = x - samples[i].position.x, dz = z - samples[i].position.z
      const d = dx * dx + dz * dz
      if (d < bestD) { bestD = d; best = i }
    }
    for (let i = Math.max(0, best - 2); i <= Math.min(samples.length - 1, best + 2); i++) {
      const dx = x - samples[i].position.x, dz = z - samples[i].position.z
      const d = dx * dx + dz * dz
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }
  const roadClearance = (x: number, z: number): number => {
    const i = nearestInPlan(x, z)
    const s = spline.samples[i]
    const dx = x - s.position.x
    const dz = z - s.position.z
    const d = Math.abs(dx * s.right.x + dz * s.right.z)
    const along = Math.abs(dx * s.tangent.x + dz * s.tangent.z)
    return along > 6 ? Math.hypot(dx, dz) : Math.min(d, Math.hypot(dx, dz))
  }

  /** Scatter instances of a geometry over the bounds, avoiding the road. */
  const scatter = (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    count: number,
    opts: { minDist: number; maxDist: number; scale: [number, number]; yOffset?: number; collide?: boolean; collideRadius?: number; randomYaw?: boolean; aboveWater?: boolean; heightRange?: [number, number] },
  ) => {
    const placements: THREE.Matrix4[] = []
    const positions: THREE.Vector3[] = []
    const size = bounds.getSize(new THREE.Vector3())
    const min = bounds.min
    let attempts = 0
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const sc = new THREE.Vector3()
    while (placements.length < count && attempts < count * 12) {
      attempts++
      const x = min.x - 120 + rng() * (size.x + 240)
      const z = min.z - 120 + rng() * (size.z + 240)
      const d = roadClearance(x, z)
      if (d < opts.minDist || d > opts.maxDist) continue
      if (shortcutClearance(x, z) < opts.minDist) continue
      const y = terrainHeight(x, z)
      if (opts.aboveWater !== false && env.waterLevel !== null && y < env.waterLevel + 0.5) continue
      if (opts.heightRange && (y < opts.heightRange[0] || y > opts.heightRange[1])) continue
      const s = lerp(opts.scale[0], opts.scale[1], rng())
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), opts.randomYaw === false ? 0 : rng() * Math.PI * 2)
      sc.set(s, s, s)
      const pos = new THREE.Vector3(x, y + (opts.yOffset ?? 0) * s, z)
      m.compose(pos, q, sc)
      placements.push(m.clone())
      positions.push(pos)
      if (opts.collide && d < 40) {
        const r = (opts.collideRadius ?? 1) * s
        const body = physics.createBody(physics.RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y + r, pos.z))
        const col = physics.world.createCollider(physics.RAPIER.ColliderDesc.cylinder(r * 1.5, r).setCollisionGroups(PROP_GROUPS), body)
        physics.registerCollider(col, { wall: true, surface: 'concrete' })
      }
    }
    // Bucket into chunks.
    const byChunk = new Map<Chunk, THREE.Matrix4[]>()
    placements.forEach((mat, i) => {
      const c = chunkFor(positions[i])
      let arr = byChunk.get(c)
      if (!arr) {
        arr = []
        byChunk.set(c, arr)
      }
      arr.push(mat)
    })
    for (const [chunk, mats] of byChunk) {
      const inst = new THREE.InstancedMesh(geometry, material, mats.length)
      inst.name = name
      mats.forEach((mm, i) => inst.setMatrixAt(i, mm))
      inst.instanceMatrix.needsUpdate = true
      inst.castShadow = true
      inst.receiveShadow = true
      root.add(inst)
      chunk.meshes.push(inst)
    }
    return positions
  }

  // --- Geometry library ------------------------------------------------------
  const barkMat = new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 0.95 })
  const conifer = new THREE.Group()
  const coniferGeo = mergeGeometries([
    translate(new THREE.CylinderGeometry(0.25, 0.4, 3, 6), 0, 1.5, 0),
    translate(new THREE.ConeGeometry(2.4, 5, 8), 0, 5, 0),
    translate(new THREE.ConeGeometry(1.8, 4.2, 8), 0, 7.5, 0),
    translate(new THREE.ConeGeometry(1.1, 3.4, 8), 0, 9.8, 0),
  ])
  void conifer
  const coniferMat = new THREE.MeshStandardMaterial({ color: env.snow ? 0x8fa896 : 0x2f6b33, roughness: 0.9, flatShading: true })
  const broadleafGeo = mergeGeometries([translate(new THREE.CylinderGeometry(0.3, 0.45, 3.5, 6), 0, 1.75, 0), translate(new THREE.IcosahedronGeometry(3.2, 1), 0, 5.5, 0), translate(new THREE.IcosahedronGeometry(2.2, 1), 1.6, 6.5, 0.8)])
  const broadleafMat = new THREE.MeshStandardMaterial({ color: 0x3d7a2e, roughness: 0.9, flatShading: true })
  const palmGeo = mergeGeometries([
    translate(new THREE.CylinderGeometry(0.18, 0.32, 7, 6), 0, 3.5, 0),
    ...[0, 1, 2, 3, 4, 5].map((i) => {
      const frond = new THREE.BoxGeometry(0.5, 0.06, 3.4)
      frond.translate(0, 0, 1.6)
      frond.rotateX(-0.6)
      frond.rotateY((i / 6) * Math.PI * 2)
      frond.translate(0, 7, 0)
      return frond
    }),
  ])
  const palmMat = new THREE.MeshStandardMaterial({ color: 0x3f8f3a, roughness: 0.85 })
  const rockGeo = new THREE.DodecahedronGeometry(1.6, 1)
  const rockMat = new THREE.MeshStandardMaterial({ color: env.terrain === 'canyon' ? 0x9a5c38 : env.snow ? 0xb8c4d0 : 0x7d7f84, roughness: 0.95, flatShading: true })
  const bushGeo = new THREE.IcosahedronGeometry(1.1, 1)
  const bushMat = new THREE.MeshStandardMaterial({ color: env.terrain === 'canyon' ? 0x7c8a3c : 0x3f7f37, roughness: 0.95, flatShading: true })
  disposables.push(coniferGeo, coniferMat, broadleafGeo, broadleafMat, palmGeo, palmMat, rockGeo, rockMat, bushGeo, bushMat, barkMat)

  const isCity = env.buildingDensity > 0
  const night = false
  if (env.treeDensity > 0) {
    const n = Math.round(420 * env.treeDensity * density)
    if (def.theme === 'island') scatter('palm', palmGeo, palmMat, n, { minDist: halfWidth + 5, maxDist: 400, scale: [0.9, 1.6], collide: true, collideRadius: 0.3 })
    else if (def.theme === 'alpine' || def.theme === 'glacier' || def.theme === 'woodland' || def.theme === 'lakeside') {
      scatter('conifer', coniferGeo, coniferMat, n, { minDist: halfWidth + 5, maxDist: 500, scale: [0.8, 1.7], collide: true, collideRadius: 0.4, heightRange: def.theme === 'alpine' ? [-100, 120] : undefined })
      if (def.theme !== 'glacier') scatter('broadleaf', broadleafGeo, broadleafMat, Math.round(n * 0.5), { minDist: halfWidth + 6, maxDist: 400, scale: [0.7, 1.4], collide: true, collideRadius: 0.45 })
    } else scatter('broadleaf', broadleafGeo, broadleafMat, n, { minDist: halfWidth + 6, maxDist: 400, scale: [0.7, 1.3], collide: true, collideRadius: 0.45 })
  }
  scatter('rock', rockGeo, rockMat, Math.round((def.theme === 'badlands' || def.theme === 'alpine' || def.theme === 'glacier' ? 260 : 60) * density), { minDist: halfWidth + 4, maxDist: 600, scale: [0.6, 3.2], collide: true, collideRadius: 1.2, yOffset: -0.3 })
  if (!env.snow) scatter('bush', bushGeo, bushMat, Math.round(220 * density), { minDist: halfWidth + 3, maxDist: 300, scale: [0.6, 1.5], yOffset: 0.2 })

  // Buildings: instances of the licensed city library when it is loaded,
  // otherwise the generated textured boxes. Same placement rules either way.
  const libBuildings = lib.get('building') ?? []
  if (isCity && libBuildings.length) {
    const buildingCount = Math.round(140 * env.buildingDensity * density)
    const positions: THREE.Vector3[] = []
    const placements: { prop: LibraryProp; matrix: THREE.Matrix4; position: THREE.Vector3 }[] = []
    const size = bounds.getSize(new THREE.Vector3())
    let attempts = 0
    while (placements.length < buildingCount && attempts < buildingCount * 20) {
      attempts++
      const x = bounds.min.x - 150 + rng() * (size.x + 300)
      const z = bounds.min.z - 150 + rng() * (size.z + 300)
      const d = roadClearance(x, z)
      const prop = libBuildings[Math.floor(rng() * libBuildings.length)]
      // Scale the library block toward the footprint the generator would have used.
      const w = 10 + rng() * 14
      const dep = 10 + rng() * 14
      const h = def.theme === 'neon' ? 14 + rng() * 30 : 9 + rng() * 22
      if (d < halfWidth + 9 + Math.max(w, dep) * 0.5 || d > 420) continue
      if (shortcutClearance(x, z) < halfWidth + 9 + Math.max(w, dep) * 0.5) continue
      if (positions.some((p) => Math.abs(p.x - x) < w + 14 && Math.abs(p.z - z) < dep + 14)) continue
      const y = terrainHeight(x, z) - 0.3
      if (env.waterLevel !== null && y < env.waterLevel) continue
      const yaw = Math.round(rng() * 4) * (Math.PI / 2)
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(w / prop.w, h / prop.h, dep / prop.d))
      const position = new THREE.Vector3(x, y, z)
      placements.push({ prop, matrix: m, position })
      positions.push(position)
      if (d < 60) {
        const body = physics.createBody(physics.RAPIER.RigidBodyDesc.fixed().setTranslation(x, y + h / 2, z).setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }))
        const col = physics.world.createCollider(physics.RAPIER.ColliderDesc.cuboid(w / 2, h / 2, dep / 2).setCollisionGroups(PROP_GROUPS), body)
        physics.registerCollider(col, { wall: true, surface: 'concrete' })
      }
    }
    placeLibrary(placements)
  } else if (isCity) {
    const styles: ('glass' | 'brick' | 'concrete' | 'neon' | 'warehouse')[] = def.theme === 'neon' ? ['neon', 'glass', 'neon', 'brick'] : def.theme === 'shipyard' ? ['warehouse', 'warehouse', 'concrete'] : ['glass', 'concrete', 'brick', 'glass']
    const buildingCount = Math.round(140 * env.buildingDensity * density)
    styles.forEach((style, si) => {
      const geo = new THREE.BoxGeometry(1, 1, 1)
      geo.translate(0, 0.5, 0)
      const facadeTex = textures.facade(style, si, false)
      const facadeNight = textures.facade(style, si, true)
      const mat = new THREE.MeshStandardMaterial({ map: facadeTex, roughness: style === 'glass' ? 0.3 : 0.85, metalness: style === 'glass' ? 0.4 : 0 })
      mat.userData = { day: facadeTex, night: facadeNight }
      nightMaterials.push(mat)
      disposables.push(geo, mat)
      const positions: THREE.Vector3[] = []
      const mats: THREE.Matrix4[] = []
      const size = bounds.getSize(new THREE.Vector3())
      let attempts = 0
      const per = Math.round(buildingCount / styles.length)
      while (mats.length < per && attempts < per * 20) {
        attempts++
        const x = bounds.min.x - 150 + rng() * (size.x + 300)
        const z = bounds.min.z - 150 + rng() * (size.z + 300)
        const d = roadClearance(x, z)
        const w = style === 'warehouse' ? 18 + rng() * 22 : 10 + rng() * 14
        const dep = style === 'warehouse' ? 22 + rng() * 20 : 10 + rng() * 14
        const h = style === 'warehouse' ? 8 + rng() * 6 : def.theme === 'neon' ? 18 + rng() * 60 : 12 + rng() * 45
        if (d < halfWidth + 9 + Math.max(w, dep) * 0.5 || d > 420) continue
        if (shortcutClearance(x, z) < halfWidth + 9 + Math.max(w, dep) * 0.5) continue
        if (positions.some((p) => Math.abs(p.x - x) < (w + 14) && Math.abs(p.z - z) < (dep + 14))) continue
        const y = terrainHeight(x, z) - 0.5
        if (env.waterLevel !== null && y < env.waterLevel) continue
        const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.round(rng() * 4) * (Math.PI / 2)), new THREE.Vector3(w, h, dep))
        mats.push(m)
        positions.push(new THREE.Vector3(x, y, z))
        if (d < 60) {
          const body = physics.createBody(physics.RAPIER.RigidBodyDesc.fixed().setTranslation(x, y + h / 2, z))
          const col = physics.world.createCollider(physics.RAPIER.ColliderDesc.cuboid(w / 2, h / 2, dep / 2).setCollisionGroups(PROP_GROUPS), body)
          physics.registerCollider(col, { wall: true, surface: 'concrete' })
        }
      }
      const byChunk = new Map<Chunk, THREE.Matrix4[]>()
      mats.forEach((mm, i) => {
        const c = chunkFor(positions[i])
        let arr = byChunk.get(c)
        if (!arr) byChunk.set(c, (arr = []))
        arr.push(mm)
      })
      for (const [chunk, ms] of byChunk) {
        const inst = new THREE.InstancedMesh(geo, mat, ms.length)
        ms.forEach((mm, i) => inst.setMatrixAt(i, mm))
        inst.instanceMatrix.needsUpdate = true
        inst.castShadow = true
        inst.receiveShadow = true
        root.add(inst)
        chunk.meshes.push(inst)
        chunk.radius = Math.max(chunk.radius, 160)
      }
      // Neon signs on facades.
      if (def.theme === 'neon' && style === 'neon') {
        const words = ['APEX', 'OVERDRIVE', 'カラオケ', 'RAMEN', 'NEON', 'ドリフト', 'TOKYO', 'GRIP', 'ナイト', '24H']
        const colors = ['#ff2d95', '#7ef0ff', '#ffd60a', '#b06bff', '#1fbf4a', '#ff6a00']
        positions.forEach((p, i) => {
          if (rng() > 0.7) return
          const mm = mats[i]
          const scl = new THREE.Vector3()
          const q = new THREE.Quaternion()
          const pp = new THREE.Vector3()
          mm.decompose(pp, q, scl)
          const sign = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ map: textures.neonSign(words[i % words.length], colors[i % colors.length]), emissive: new THREE.Color(colors[i % colors.length]), emissiveMap: textures.neonSign(words[i % words.length], colors[i % colors.length]), emissiveIntensity: 2.2, side: THREE.DoubleSide }))
          // Face the road.
          const ni = spline.nearestIndex(p)
          const toRoad = spline.samples[ni].position.clone().sub(p)
          toRoad.y = 0
          sign.position.copy(p).addScaledVector(toRoad.normalize(), Math.max(scl.x, scl.z) * 0.5 + 0.2)
          sign.position.y = p.y + 8 + rng() * Math.max(6, scl.y * 0.6)
          sign.lookAt(sign.position.clone().add(toRoad))
          root.add(sign)
          chunkFor(p).meshes.push(sign)
        })
      }
    })
  }

  // Trackside dressing from the city library: shops and kiosks beside the
  // road (dense on city circuits, sparse elsewhere), guard railings along the
  // start straight and bollards on the outside of corners.
  if (lib.size) {
    const shops: { prop: LibraryProp; matrix: THREE.Matrix4; position: THREE.Vector3 }[] = []
    const spacing = (isCity ? 34 : 90) / Math.max(0.4, density)
    for (let d = 40, k = 0; d < spline.length - 40; d += spacing, k++) {
      const prop = pick('shop')
      if (!prop) break
      const s = spline.atDistance(d)
      const side = k % 2 === 0 ? 1 : -1
      const off = halfWidth + 6 + rng() * 3 + Math.max(prop.w, prop.d) * 0.5
      const p = s.position.clone().addScaledVector(s.right, side * off)
      const y = terrainHeight(p.x, p.z)
      if (Math.abs(y - s.position.y) > 2.5) continue // hillside or bridge — no flat verge
      if (env.waterLevel !== null && y < env.waterLevel + 0.5) continue
      if (shortcutClearance(p.x, p.z) < halfWidth + 4) continue
      p.y = y
      const yaw = Math.atan2(s.tangent.x, s.tangent.z) + (side > 0 ? -Math.PI / 2 : Math.PI / 2)
      const m = new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1))
      shops.push({ prop, matrix: m, position: p })
      const r = Math.max(prop.w, prop.d) * 0.5
      const body = physics.createBody(physics.RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y + prop.h / 2, p.z).setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }))
      const col = physics.world.createCollider(physics.RAPIER.ColliderDesc.cuboid(prop.w / 2, prop.h / 2, prop.d / 2).setCollisionGroups(PROP_GROUPS), body)
      physics.registerCollider(col, { wall: true, surface: 'concrete' })
      void r
    }
    placeLibrary(shops)
    const railings: { prop: LibraryProp; matrix: THREE.Matrix4; position: THREE.Vector3 }[] = []
    const rail = pick('railing')
    if (rail) {
      for (const side of [-1, 1]) {
        for (let d = -140; d < 140; d += rail.d) {
          const s = spline.atDistance(d)
          const p = s.position.clone().addScaledVector(s.right, side * (halfWidth + 2.6))
          p.y = s.position.y
          const yaw = Math.atan2(s.tangent.x, s.tangent.z)
          railings.push({ prop: rail, matrix: new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1)), position: p })
        }
      }
      placeLibrary(railings, false)
    }
    const bollards: { prop: LibraryProp; matrix: THREE.Matrix4; position: THREE.Vector3 }[] = []
    for (let i = 0; i < spline.count; i += 4) {
      const s = spline.sampleAt(i)
      if (Math.abs(s.curvature) < 0.006) continue
      const prop = pick('bollard')
      if (!prop) break
      const side = s.curvature > 0 ? 1 : -1 // outside of the corner
      const p = s.position.clone().addScaledVector(s.right, side * (halfWidth + 3.2))
      p.y = terrainHeight(p.x, p.z)
      if (Math.abs(p.y - s.position.y) > 1.5) continue
      bollards.push({ prop, matrix: new THREE.Matrix4().compose(p, new THREE.Quaternion(), new THREE.Vector3(2.5, 2.5, 2.5)), position: p })
    }
    placeLibrary(bollards, false)
  }

  // Shipyard containers and cranes.
  if (def.theme === 'shipyard') {
    const containerGeo = new THREE.BoxGeometry(2.4, 2.6, 12)
    containerGeo.translate(0, 1.3, 0)
    const cols = ['#c8402a', '#2a6fc8', '#3f8f3a', '#d9a520', '#6a6f75']
    cols.forEach((c) => {
      const mat = new THREE.MeshStandardMaterial({ map: textures.container(c), roughness: 0.7, metalness: 0.3 })
      disposables.push(mat)
      scatter('container', containerGeo, mat, Math.round(40 * density), { minDist: halfWidth + 4, maxDist: 220, scale: [1, 1], collide: true, collideRadius: 1.4, randomYaw: true })
    })
    disposables.push(containerGeo)
    const craneGeo = mergeGeometries([translate(new THREE.BoxGeometry(2, 30, 2), -8, 15, 0), translate(new THREE.BoxGeometry(2, 30, 2), 8, 15, 0), translate(new THREE.BoxGeometry(22, 2, 2), 0, 31, 0), translate(new THREE.BoxGeometry(2, 2, 40), 0, 33, 0)])
    const craneMat = new THREE.MeshStandardMaterial({ color: 0xe8b21a, roughness: 0.6, metalness: 0.4 })
    disposables.push(craneGeo, craneMat)
    scatter('crane', craneGeo, craneMat, Math.round(10 * density), { minDist: halfWidth + 30, maxDist: 320, scale: [0.8, 1.3] })
  }

  // Street lights.
  if (env.hasStreetLights) {
    const poleGeo = mergeGeometries([translate(new THREE.CylinderGeometry(0.12, 0.18, 9, 8), 0, 4.5, 0), translate(new THREE.BoxGeometry(0.2, 0.2, 2.6), 0, 9, 1.2), translate(new THREE.BoxGeometry(0.5, 0.18, 0.9), 0, 9, 2.3)])
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.7, roughness: 0.4 })
    const lampGeo = new THREE.BoxGeometry(0.5, 0.1, 0.9)
    lampGeo.translate(0, 8.9, 2.3)
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1c0, emissive: 0xffe6a8, emissiveIntensity: 0 })
    nightMaterials.push(lampMat)
    disposables.push(poleGeo, poleMat, lampGeo, lampMat)
    const poles: THREE.Matrix4[] = []
    const posList: THREE.Vector3[] = []
    for (let d = 0; d < spline.length; d += 32) {
      const s = spline.atDistance(d)
      const side = Math.floor(d / 32) % 2 === 0 ? 1 : -1
      const p = s.position.clone().addScaledVector(s.right, side * (halfWidth + 2.2))
      p.y = s.position.y
      const yaw = Math.atan2(s.tangent.x, s.tangent.z) + (side > 0 ? Math.PI / 2 : -Math.PI / 2) + Math.PI
      poles.push(new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1)))
      posList.push(p.clone().add(new THREE.Vector3(-Math.sin(yaw) * 2.3, 8.7, -Math.cos(yaw) * 2.3)))
    }
    const byChunk = new Map<Chunk, number[]>()
    poles.forEach((_, i) => {
      const c = chunkFor(posList[i])
      let arr = byChunk.get(c)
      if (!arr) byChunk.set(c, (arr = []))
      arr.push(i)
    })
    for (const [chunk, idx] of byChunk) {
      const inst = new THREE.InstancedMesh(poleGeo, poleMat, idx.length)
      const lamps = new THREE.InstancedMesh(lampGeo, lampMat, idx.length)
      idx.forEach((i, k) => {
        inst.setMatrixAt(k, poles[i])
        lamps.setMatrixAt(k, poles[i])
      })
      inst.instanceMatrix.needsUpdate = true
      lamps.instanceMatrix.needsUpdate = true
      inst.castShadow = true
      root.add(inst, lamps)
      chunk.meshes.push(inst, lamps)
    }
    lampPositions.push(...posList)
  }

  // Crowds + grandstands.
  const crowdTex = textures.crowd()
  const crowdMat = new THREE.MeshBasicMaterial({ map: crowdTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide })
  const crowdGeo = new THREE.PlaneGeometry(0.9, 1.9)
  crowdGeo.translate(0, 0.95, 0)
  const standMat = new THREE.MeshStandardMaterial({ color: 0x30343b, roughness: 0.8 })
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x9a2d3a, roughness: 0.8 })
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xe8eaf0, roughness: 0.6, metalness: 0.2 })
  disposables.push(crowdMat, crowdGeo, standMat, seatMat, roofMat)
  for (const f of def.features) {
    if (f.type !== 'crowd') continue
    const s = spline.atT(f.at)
    const len = f.length
    const rows = f.grandstand ? 6 : 2
    const perRow = Math.max(4, Math.round((len / 1.1) * Math.min(1, density + 0.3)))
    const count = rows * perRow
    const inst = new THREE.InstancedMesh(crowdGeo, crowdMat, count)
    const phases = new Float32Array(count)
    const base: THREE.Matrix4[] = []
    const yaw = Math.atan2(s.tangent.x, s.tangent.z) + (f.side > 0 ? -Math.PI / 2 : Math.PI / 2)
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    const zoneCenter = new THREE.Vector3()
    let k = 0
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < perRow; i++) {
        const along = (i / (perRow - 1) - 0.5) * len
        const sample = spline.atDistance(s.distance + along)
        const p = sample.position.clone().addScaledVector(sample.right, f.side * (halfWidth + 3.5 + r * 1.2))
        p.y = sample.position.y + (f.grandstand ? 0.6 + r * 0.75 : 0) + 0.02
        const sc = 0.9 + rng() * 0.25
        const m = new THREE.Matrix4().compose(p, q, new THREE.Vector3(sc, sc, sc))
        inst.setMatrixAt(k, m)
        base.push(m)
        phases[k] = rng() * Math.PI * 2
        k++
        zoneCenter.add(p)
      }
    }
    zoneCenter.divideScalar(Math.max(1, count))
    inst.instanceMatrix.needsUpdate = true
    inst.frustumCulled = true
    root.add(inst)
    animated.push({ mesh: inst, phases, base })
    // Map the crowd texture columns to instances via UV offset per instance is not supported on InstancedMesh basic; vary by scale instead.
    crowdZones.push({ position: zoneCenter, radius: len * 0.6 + 20 })
    if (f.grandstand) {
      // Grandstand tiers, roof and collider are built in short segments that follow the spline,
      // so a long stand on a curving straight never cuts across the road.
      const stand = new THREE.Group()
      const segLen = 10
      const segCount = Math.max(1, Math.round(len / segLen))
      const totalH = rows * 0.75 + 3.4
      for (let k = 0; k < segCount; k++) {
        const along = (k + 0.5) * segLen - len / 2
        const sample = spline.atDistance(s.distance + along)
        const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(sample.tangent.x, sample.tangent.z))
        for (let r = 0; r < rows; r++) {
          const h = 0.75 + r * 0.75
          const tier = new THREE.Mesh(new THREE.BoxGeometry(1.25, h, segLen + 0.3), r % 2 ? seatMat : standMat)
          tier.position.copy(sample.position).addScaledVector(sample.right, f.side * (halfWidth + 3.5 + r * 1.2))
          tier.position.y = sample.position.y + h / 2
          tier.quaternion.copy(yawQ)
          tier.receiveShadow = true
          stand.add(tier)
        }
        const roof = new THREE.Mesh(new THREE.BoxGeometry(rows * 1.3 + 2, 0.2, segLen + 0.3), roofMat)
        roof.position.copy(sample.position).addScaledVector(sample.right, f.side * (halfWidth + 3.5 + rows * 0.6))
        roof.position.y = sample.position.y + totalH
        roof.quaternion.copy(yawQ)
        roof.castShadow = true
        stand.add(roof)
        if (k % 2 === 0) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, totalH, 8), standMat)
          post.position.copy(sample.position).addScaledVector(sample.right, f.side * (halfWidth + 3.5 + rows * 1.2))
          post.position.y = sample.position.y + totalH / 2
          stand.add(post)
        }
        // Collider for this segment's front face.
        const cx = sample.position.x + sample.right.x * f.side * (halfWidth + 3.0)
        const cz = sample.position.z + sample.right.z * f.side * (halfWidth + 3.0)
        const body = physics.createBody(physics.RAPIER.RigidBodyDesc.fixed().setTranslation(cx, sample.position.y + 1.0, cz).setRotation({ x: yawQ.x, y: yawQ.y, z: yawQ.z, w: yawQ.w }))
        const col = physics.world.createCollider(physics.RAPIER.ColliderDesc.cuboid(0.4, 1.2, segLen / 2 + 0.2).setCollisionGroups(PROP_GROUPS), body)
        physics.registerCollider(col, { wall: true, surface: 'concrete' })
      }
      root.add(stand)
    }
  }

  // Water plane.
  if (env.waterLevel !== null) {
    const size = bounds.getSize(new THREE.Vector3())
    const waterGeo = new THREE.PlaneGeometry(size.x + 1600, size.z + 1600, 1, 1)
    const waterMat = new THREE.MeshPhysicalMaterial({ color: def.theme === 'island' ? 0x1a8fa8 : def.theme === 'shipyard' ? 0x24343c : 0x2b5f7a, roughness: 0.12, metalness: 0.15, transparent: true, opacity: 0.92, envMapIntensity: 1.6, clearcoat: 1, clearcoatRoughness: 0.08 })
    waterMat.normalScale = new THREE.Vector2(0.15, 0.15)
    const water = new THREE.Mesh(waterGeo, waterMat)
    water.rotation.x = -Math.PI / 2
    const c = bounds.getCenter(new THREE.Vector3())
    water.position.set(c.x, env.waterLevel, c.z)
    water.receiveShadow = true
    root.add(water)
    disposables.push(waterGeo, waterMat)
    animated.push({ mesh: water as unknown as THREE.InstancedMesh, phases: new Float32Array(0), base: [] })
  }

  const chunkList = [...chunks.values()]
  const tmpM = new THREE.Matrix4()
  const tmpP = new THREE.Vector3()
  const tmpQ = new THREE.Quaternion()
  const tmpS = new THREE.Vector3()
  let frame = 0
  void night

  return {
    root,
    crowdZones,
    lampPositions,
    updateVisibility(cameraPos, drawDistance, time) {
      frame++
      for (const c of chunkList) {
        const d = Math.hypot(c.center.x - cameraPos.x, c.center.z - cameraPos.z) - c.radius
        const visible = d < drawDistance
        for (const m of c.meshes) m.visible = visible
      }
      // Crowd bounce, updated at 20 Hz for the nearest zones only.
      if (frame % 3 === 0) {
        for (const a of animated) {
          if (a.base.length === 0) continue
          const mesh = a.mesh
          if (mesh.position.distanceTo(cameraPos) > 0 && !mesh.visible) continue
          const count = a.base.length
          for (let i = 0; i < count; i++) {
            a.base[i].decompose(tmpP, tmpQ, tmpS)
            const bounce = Math.max(0, Math.sin(time * 6 + a.phases[i])) * 0.25
            tmpP.y += bounce
            tmpM.compose(tmpP, tmpQ, tmpS)
            mesh.setMatrixAt(i, tmpM)
          }
          mesh.instanceMatrix.needsUpdate = true
        }
      }
    },
    setNight(nightFactor) {
      for (const m of nightMaterials) {
        if (m.userData.day && m.userData.night) {
          const wantNight = nightFactor > 0.5
          const target = wantNight ? m.userData.night : m.userData.day
          if (m.map !== target) {
            m.map = target
            m.emissiveMap = wantNight ? target : null
            m.emissive.set(wantNight ? 0xffffff : 0x000000)
            m.emissiveIntensity = wantNight ? 0.9 : 0
            m.needsUpdate = true
          }
        } else {
          m.emissiveIntensity = nightFactor > 0.4 ? 2.5 : 0
        }
      }
    },
    dispose() {
      for (const d of disposables) d.dispose()
      root.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
          o.geometry.dispose()
          const mat = o.material as THREE.Material | THREE.Material[]
          if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose())
          else mat.dispose()
        }
      })
    },
  }
}

function translate(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  g.translate(x, y, z)
  return g
}

/** Minimal non-indexed geometry merge (position + normal + uv). */
export function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  for (const g of geos) {
    const ng = g.index ? g.toNonIndexed() : g
    const p = ng.attributes.position.array
    const n = ng.attributes.normal?.array
    const uv = ng.attributes.uv?.array
    for (let i = 0; i < p.length; i++) positions.push(p[i])
    if (n) for (let i = 0; i < n.length; i++) normals.push(n[i])
    if (uv) for (let i = 0; i < uv.length; i++) uvs.push(uv[i])
    else for (let i = 0; i < (p.length / 3) * 2; i++) uvs.push(0)
    g.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  if (normals.length === positions.length) out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  else out.computeVertexNormals()
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return out
}
