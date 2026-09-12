/**
 * Trackside photo billboards (the "Fam Jam" hoardings).
 *
 * A billboard is a posted panel on two legs, sized like a trackside advertising
 * hoarding (9.6 × 5.4 m panel on a dark frame, 1.4 m off the ground), turned
 * to face the road and angled toward approaching cars, with a caption strip
 * along the bottom and a light bar that backlights it at night. Boards are
 * spread around the lap with deterministic spacing, skipping the pit lane,
 * tunnels and bridges, kept clear of the racing line and of existing scenery,
 * and cycle through every photo of the set before any repeats.
 *
 * Everything is instanced per spatial chunk like the rest of the scenery, the
 * legs and frame carry prop colliders (so a car cannot drive through them, but
 * nothing reaches the road), and the whole lot is released with the track.
 * Photos come from a manifest written by tools/asset-pipeline/prepare-photos.mjs;
 * a missing or empty manifest leaves plain blank boards and no errors.
 */

import * as THREE from 'three'
import type { PhysicsWorld } from '../physics/PhysicsWorld'
import { CollisionGroup, makeGroups } from '../physics/Surfaces'
import type { TextureFactory } from '../render/TextureFactory'
import { Logger } from '../core/Logger'
import type { PhotoBillboardConfig, TrackDefinition } from './TrackCatalog'
import type { TrackSpline } from './Spline'

const log = Logger.scope('Billboards')

export interface PhotoEntry {
  file: string
  caption: string
}

export interface BillboardSet {
  /** Folder the manifest lives in, under the app base URL (e.g. 'assets/photos/fam-jam'). */
  folder: string
  photos: PhotoEntry[]
}

export interface BillboardsResult {
  root: THREE.Group
  /** Boards actually placed, in lap order. */
  placed: { position: THREE.Vector3; distance: number; side: number; photo: number }[]
  updateVisibility(cameraPos: THREE.Vector3, drawDistance: number): void
  setNight(nightFactor: number): void
  dispose(): void
}

export interface BillboardSite {
  /** Pit lane in metres of arc length (boards skip the pit side there). */
  pitZone: { from: number; to: number; side: number } | null
  /** Tunnel spans in metres. */
  tunnelZones: { from: number; to: number }[]
  /** True when the normalised lap parameter is on a bridge. */
  onBridge: (t: number) => boolean
  /** Scene root holding the circuit's own meshes; model scenery/wall nodes feed the clearance test. */
  sceneRoot: THREE.Object3D
}

export const DEFAULT_PHOTO_SET = 'assets/photos/fam-jam'

// Hoarding dimensions (metres).
const PANEL_W = 9.6
const PANEL_H = PANEL_W * 9 / 16
const CAPTION_H = 0.9
const FRAME_BORDER = 0.22
const FRAME_DEPTH = 0.22
const LEG_H = 1.4
const LEG_W = 0.22
const FRAME_W = PANEL_W + FRAME_BORDER * 2
const FRAME_H = PANEL_H + CAPTION_H + FRAME_BORDER * 2
/** Angle the board turns from "square to the road" toward the cars driving up to it. */
const APPROACH_ANGLE = 0.42
const CHUNK = 120
const PROP_GROUPS = makeGroups(CollisionGroup.PROP, CollisionGroup.ALL)
/** Membership VEHICLE, filter GROUND: the same ray the wheels use to find the road. */
const GROUND_RAY_GROUPS = makeGroups(CollisionGroup.VEHICLE, CollisionGroup.GROUND)
/** Anything that is not ground: walls, props, hazards. */
const OBSTACLE_GROUPS = makeGroups(CollisionGroup.VEHICLE, CollisionGroup.PROP | CollisionGroup.HAZARD | CollisionGroup.TRIGGER)

/**
 * Fetch a photo manifest. Resolves to an empty set (never throws) when the file
 * is missing, not JSON (a dev server answers unknown paths with index.html), or
 * lists nothing usable.
 */
export async function loadPhotoSet(folder = DEFAULT_PHOTO_SET): Promise<BillboardSet> {
  const clean = folder.replace(/\/+$/, '')
  const url = `${import.meta.env.BASE_URL}${clean}/manifest.json`
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) {
      log.info(`No photo set at ${clean} (${res.status}) — blank boards`)
      return { folder: clean, photos: [] }
    }
    const text = await res.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      log.info(`No photo manifest at ${clean} — blank boards`)
      return { folder: clean, photos: [] }
    }
    const list = (data as { photos?: unknown }).photos
    const photos: PhotoEntry[] = Array.isArray(list)
      ? list
          .filter((p): p is { file: string; caption?: unknown } => !!p && typeof p === 'object' && typeof (p as { file?: unknown }).file === 'string' && /\.(jpe?g|png|webp)$/i.test((p as { file: string }).file) && !(p as { file: string }).file.includes('..'))
          .map((p) => ({ file: p.file, caption: typeof p.caption === 'string' ? p.caption.trim() : '' }))
      : []
    if (!photos.length) log.info(`Photo manifest at ${clean} lists no photos — blank boards`)
    else log.info(`${photos.length} photo(s) in ${clean}`)
    return { folder: clean, photos }
  } catch (err) {
    log.info(`Photo set ${clean} unavailable (${err instanceof Error ? err.message : String(err)}) — blank boards`)
    return { folder: clean, photos: [] }
  }
}

interface Chunk {
  center: THREE.Vector3
  meshes: THREE.Object3D[]
  radius: number
}

/**
 * Plan-view occupancy of the circuit model's own scenery and walls: min/max
 * height of their vertices per 3 m cell. Cheap to build once and enough to tell
 * whether a hoarding footprint would land in a tree, a building or a barrier.
 */
class OccupancyGrid {
  private readonly cells = new Map<string, { min: number; max: number }>()
  readonly cell = 3
  readonly vertices: number
  constructor(root: THREE.Object3D) {
    let n = 0
    const v = new THREE.Vector3()
    root.updateWorldMatrix(true, true)
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      let cls = ''
      for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (/^(prop|wall)/.test(p.name)) { cls = p.name; break }
      if (!cls) return
      const pos = o.geometry.attributes.position
      if (!pos) return
      const step = Math.max(1, Math.floor(pos.count / 400000))
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld)
        const k = this.key(v.x, v.z)
        const c = this.cells.get(k)
        if (!c) this.cells.set(k, { min: v.y, max: v.y })
        else { if (v.y < c.min) c.min = v.y; if (v.y > c.max) c.max = v.y }
        n++
      }
    })
    this.vertices = n
  }
  private key(x: number, z: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`
  }
  /** Any scenery vertex between `ground + 0.25` and `ground + 7` inside the cell at (x, z)? */
  occupied(x: number, z: number, ground: number): boolean {
    const c = this.cells.get(this.key(x, z))
    return !!c && c.max > ground + 0.25 && c.min < ground + 7
  }
}

export function buildBillboards(
  def: TrackDefinition,
  cfg: PhotoBillboardConfig,
  set: BillboardSet,
  spline: TrackSpline,
  halfWidthAt: (sampleIndex: number) => number,
  textures: TextureFactory,
  physics: PhysicsWorld,
  site: BillboardSite,
): BillboardsResult {
  const root = new THREE.Group()
  root.name = 'billboards'
  const chunks = new Map<string, Chunk>()
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = []
  const R = physics.RAPIER
  // Colliders created while the track was built are invisible to queries until the
  // query pipeline is refreshed.
  physics.world.updateSceneQueries()
  const grid = new OccupancyGrid(site.sceneRoot)

  const chunkFor = (p: THREE.Vector3): Chunk => {
    const key = `${Math.floor(p.x / CHUNK)},${Math.floor(p.z / CHUNK)}`
    let c = chunks.get(key)
    if (!c) {
      c = { center: new THREE.Vector3((Math.floor(p.x / CHUNK) + 0.5) * CHUNK, 0, (Math.floor(p.z / CHUNK) + 0.5) * CHUNK), meshes: [], radius: CHUNK * 0.75 }
      chunks.set(key, c)
    }
    return c
  }

  // --- Ground and clearance queries -------------------------------------------
  const groundAt = (x: number, z: number, near: number): number | null => {
    let best: number | null = null
    const top = near + 25
    physics.world.intersectionsWithRay(new R.Ray({ x, y: top, z }, { x: 0, y: -1, z: 0 }), 50, true, (hit) => {
      const meta = physics.getMeta(hit.collider.handle)
      if (meta && meta.surface && !meta.wall) {
        const y = top - hit.timeOfImpact
        if (best === null || Math.abs(y - near) < Math.abs(best - near)) best = y
      }
      return true
    }, undefined, GROUND_RAY_GROUPS)
    return best
  }
  const shape = new R.Cuboid(FRAME_W / 2 + 0.6, (LEG_H + FRAME_H) / 2 + 0.3, FRAME_DEPTH / 2 + 1.2)
  const blockedByCollider = (x: number, y: number, z: number, q: THREE.Quaternion): boolean => {
    let hit = false
    physics.world.intersectionsWithShape({ x, y: y + (LEG_H + FRAME_H) / 2, z }, { x: q.x, y: q.y, z: q.z, w: q.w }, shape, () => { hit = true; return false }, undefined, OBSTACLE_GROUPS)
    return hit
  }
  const footprintClear = (x: number, z: number, ground: number, yaw: number): boolean => {
    // Sample the footprint (frame width × 1.5 m either way) against the scenery grid.
    // Board-local (u across, v toward the road) → world for a yaw about +Y.
    const c = Math.cos(yaw), s = Math.sin(yaw)
    for (let u = -FRAME_W / 2 - 1; u <= FRAME_W / 2 + 1; u += 1.5) {
      for (let v = -1.5; v <= 1.5; v += 1.5) {
        if (grid.occupied(x + c * u + s * v, z - s * u + c * v, ground)) return false
      }
    }
    return true
  }

  // --- Where along the lap ------------------------------------------------------
  const zones = cfg.zones && cfg.zones.length ? cfg.zones : [{ from: 0, to: 1, side: 'alternate' as const }]
  const totalT = zones.reduce((s, z) => s + Math.max(0, z.to - z.from), 0) || 1
  const inPitSide = (dist: number, side: number) => {
    const p = site.pitZone
    if (!p || side !== p.side) return false
    const margin = 35
    const from = p.from - margin, to = p.to + margin
    // A pit zone that wraps the start line has from > to.
    return p.from <= p.to ? dist >= from && dist <= to : dist >= from || dist <= to
  }
  const inTunnel = (dist: number) => site.tunnelZones.some((z) => dist >= z.from - 25 && dist <= z.to + 25)

  interface Slot { dist: number; side: number }
  const slots: Slot[] = []
  let k = 0
  for (const zone of zones) {
    const span = Math.max(0, zone.to - zone.from)
    const n = Math.max(1, Math.round((cfg.count * span) / totalT))
    const spacing = span / n
    for (let i = 0; i < n; i++, k++) {
      const t = zone.from + (i + 0.5) * spacing
      const side = zone.side === 'alternate' ? (k % 2 === 0 ? 1 : -1) : zone.side
      slots.push({ dist: (t % 1) * spline.length, side })
    }
  }

  // --- Placement -----------------------------------------------------------------
  const placed: BillboardsResult['placed'] = []
  const yAxis = new THREE.Vector3(0, 1, 0)
  const tryPlace = (dist: number, side: number): { p: THREE.Vector3; q: THREE.Quaternion; ground: number } | null => {
    const s = spline.atDistance(((dist % spline.length) + spline.length) % spline.length)
    const t = s.distance / spline.length
    if (inTunnel(s.distance) || site.onBridge(t) || inPitSide(s.distance, side)) return null
    const i = spline.nearestIndex(s.position)
    const hw = halfWidthAt(i)
    // Face the road (the board's local +z is its front), then turn toward the cars
    // driving up to it, which arrive from the -tangent direction.
    const face = new THREE.Vector3(-s.right.x * side, 0, -s.right.z * side).normalize()
    face.multiplyScalar(Math.cos(APPROACH_ANGLE)).addScaledVector(new THREE.Vector3(s.tangent.x, 0, s.tangent.z).normalize(), -Math.sin(APPROACH_ANGLE)).normalize()
    const yaw = Math.atan2(face.x, face.z)
    const q = new THREE.Quaternion().setFromAxisAngle(yAxis, yaw)
    const legDx = Math.cos(yaw) * (PANEL_W / 2 - 0.9), legDz = -Math.sin(yaw) * (PANEL_W / 2 - 0.9)
    for (const extra of [0, 1.5, 3]) {
      const off = hw + 5.5 + extra
      const x = s.position.x + s.right.x * side * off
      const z = s.position.z + s.right.z * side * off
      const gL = groundAt(x - legDx, z - legDz, s.position.y)
      const gR = groundAt(x + legDx, z + legDz, s.position.y)
      const gC = groundAt(x, z, s.position.y)
      if (gL === null || gR === null || gC === null) continue
      const ground = Math.min(gL, gR, gC)
      if (Math.abs(gL - gR) > 0.7 || Math.abs(ground - s.position.y) > 3) continue // hillside, drop or bridge
      if (!footprintClear(x, z, ground, yaw)) continue
      if (blockedByCollider(x, ground, z, q)) continue
      return { p: new THREE.Vector3(x, ground, z), q, ground }
    }
    return null
  }

  const spacingM = spline.length / Math.max(1, slots.length)
  const photoCount = set.photos.length
  let photoIdx = 0
  const boards: { p: THREE.Vector3; q: THREE.Quaternion; photo: number; dist: number; side: number }[] = []
  for (const slot of slots) {
    let hit: ReturnType<typeof tryPlace> = null
    let dist = slot.dist
    for (const shift of [0, 0.18, -0.18, 0.36]) {
      dist = slot.dist + shift * spacingM
      hit = tryPlace(dist, slot.side)
      if (hit) break
    }
    if (!hit) continue
    // Keep boards apart: a shifted slot must not crowd its neighbour.
    if (boards.some((b) => b.p.distanceTo(hit!.p) < 40)) continue
    const photo = photoCount ? photoIdx++ % photoCount : -1
    boards.push({ p: hit.p, q: hit.q, photo, dist, side: slot.side })
    placed.push({ position: hit.p, distance: dist, side: slot.side, photo })
  }

  // --- Geometry --------------------------------------------------------------------
  // Frame: a slab behind the panel plus two legs, in the board's local space
  // (x across, y up from the ground, +z toward the road / viewer).
  const slab = new THREE.BoxGeometry(FRAME_W, FRAME_H, FRAME_DEPTH)
  slab.translate(0, LEG_H + FRAME_H / 2, -FRAME_DEPTH / 2)
  const legL = new THREE.BoxGeometry(LEG_W, LEG_H + 0.4, LEG_W)
  legL.translate(-(PANEL_W / 2 - 0.9), (LEG_H + 0.4) / 2, -FRAME_DEPTH / 2)
  const legR = new THREE.BoxGeometry(LEG_W, LEG_H + 0.4, LEG_W)
  legR.translate(PANEL_W / 2 - 0.9, (LEG_H + 0.4) / 2, -FRAME_DEPTH / 2)
  const brace = new THREE.BoxGeometry(FRAME_W - 1, 0.12, 0.12)
  brace.translate(0, LEG_H - 0.3, -FRAME_DEPTH / 2)
  const frameGeo = mergeBoxes([slab, legL, legR, brace])
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.7, metalness: 0.35 })
  // Light bar along the top edge, tilted onto the panel; emissive at night.
  const lampGeo = new THREE.BoxGeometry(PANEL_W, 0.09, 0.42)
  lampGeo.translate(0, LEG_H + FRAME_H + 0.05, 0.16)
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xd9dde3, emissive: 0xfff2d0, emissiveIntensity: 0, roughness: 0.5, metalness: 0.3 })
  // Panel and caption strip sit 5 mm proud of the frame face so they never z-fight.
  const panelGeo = new THREE.PlaneGeometry(PANEL_W, PANEL_H)
  panelGeo.translate(0, LEG_H + FRAME_BORDER + CAPTION_H + PANEL_H / 2, 0.005)
  const captionGeo = new THREE.PlaneGeometry(PANEL_W, CAPTION_H)
  captionGeo.translate(0, LEG_H + FRAME_BORDER + CAPTION_H / 2, 0.005)
  disposables.push(frameGeo, frameMat, lampGeo, lampMat, panelGeo, captionGeo)

  const blankTex = textures.blankBoard()
  const panelMats = new Map<number, THREE.MeshStandardMaterial>()
  const captionMats = new Map<number, THREE.MeshStandardMaterial>()
  const nightMats: THREE.MeshStandardMaterial[] = []
  const panelMaterial = (photo: number): THREE.MeshStandardMaterial => {
    let m = panelMats.get(photo)
    if (m) return m
    const map = blankTex
    m = new THREE.MeshStandardMaterial({ map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0, roughness: 0.55, metalness: 0 })
    panelMats.set(photo, m)
    nightMats.push(m)
    disposables.push(m)
    return m
  }
  const captionMaterial = (photo: number): THREE.MeshStandardMaterial | null => {
    const entry = photo >= 0 ? set.photos[photo] : null
    if (!entry || !entry.caption) return null
    let m = captionMats.get(photo)
    if (m) return m
    const map = textures.caption(entry.caption)
    m = new THREE.MeshStandardMaterial({ map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0, roughness: 0.6, metalness: 0 })
    captionMats.set(photo, m)
    nightMats.push(m)
    disposables.push(m)
    return m
  }

  // --- Instancing per chunk --------------------------------------------------------
  const byChunk = new Map<Chunk, typeof boards>()
  for (const b of boards) {
    const c = chunkFor(b.p)
    ;(byChunk.get(c) ?? byChunk.set(c, []).get(c)!).push(b)
  }
  const one = new THREE.Vector3(1, 1, 1)
  const matrixOf = (b: (typeof boards)[number]) => new THREE.Matrix4().compose(b.p, b.q, one)
  const addInstanced = (chunk: Chunk, geo: THREE.BufferGeometry, mat: THREE.Material, list: typeof boards, cast: boolean, name: string) => {
    const inst = new THREE.InstancedMesh(geo, mat, list.length)
    list.forEach((b, i) => inst.setMatrixAt(i, matrixOf(b)))
    inst.instanceMatrix.needsUpdate = true
    inst.castShadow = cast
    inst.receiveShadow = true
    inst.name = name
    root.add(inst)
    chunk.meshes.push(inst)
    chunk.radius = Math.max(chunk.radius, 160)
  }
  for (const [chunk, list] of byChunk) {
    addInstanced(chunk, frameGeo, frameMat, list, true, 'billboard-frame')
    addInstanced(chunk, lampGeo, lampMat, list, false, 'billboard-lamp')
    const byPhoto = new Map<number, typeof boards>()
    for (const b of list) (byPhoto.get(b.photo) ?? byPhoto.set(b.photo, []).get(b.photo)!).push(b)
    for (const [photo, group] of byPhoto) {
      addInstanced(chunk, panelGeo, panelMaterial(photo), group, false, 'billboard-panel')
      const cm = captionMaterial(photo)
      if (cm) addInstanced(chunk, captionGeo, cm, group, false, 'billboard-caption')
    }
  }

  // --- Colliders: legs and frame, so a car stops at the posts but nothing invisible
  // sits nearer the road than the visible board itself. ------------------------------
  for (const b of boards) {
    const rot = { x: b.q.x, y: b.q.y, z: b.q.z, w: b.q.w }
    const local = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(b.q).add(b.p)
    for (const lx of [-(PANEL_W / 2 - 0.9), PANEL_W / 2 - 0.9]) {
      const c = local(lx, (LEG_H + 0.4) / 2, -FRAME_DEPTH / 2)
      const body = physics.createBody(R.RigidBodyDesc.fixed().setTranslation(c.x, c.y, c.z).setRotation(rot))
      const col = physics.world.createCollider(R.ColliderDesc.cuboid(LEG_W / 2, (LEG_H + 0.4) / 2, LEG_W / 2).setCollisionGroups(PROP_GROUPS), body)
      physics.registerCollider(col, { wall: true, surface: 'concrete' })
    }
    const fc = local(0, LEG_H + FRAME_H / 2, -FRAME_DEPTH / 2)
    const body = physics.createBody(R.RigidBodyDesc.fixed().setTranslation(fc.x, fc.y, fc.z).setRotation(rot))
    const col = physics.world.createCollider(R.ColliderDesc.cuboid(FRAME_W / 2, FRAME_H / 2, FRAME_DEPTH / 2).setCollisionGroups(PROP_GROUPS), body)
    physics.registerCollider(col, { wall: true, surface: 'concrete' })
  }

  log.info(`${def.name}: ${boards.length} of ${slots.length} billboard slots placed, ${photoCount} photo(s)${grid.vertices ? `, scenery grid ${grid.vertices} vertices` : ''}`)

  const chunkList = [...chunks.values()]
  return {
    root,
    placed,
    updateVisibility(cameraPos, drawDistance) {
      for (const c of chunkList) {
        const d = Math.hypot(c.center.x - cameraPos.x, c.center.z - cameraPos.z) - c.radius
        const visible = d < drawDistance
        for (const m of c.meshes) m.visible = visible
      }
    },
    setNight(nightFactor) {
      const on = nightFactor > 0.45
      lampMat.emissiveIntensity = on ? 2.6 : 0
      for (const m of nightMats) m.emissiveIntensity = on ? 0.42 : 0
    },
    dispose() {
      for (const d of disposables) d.dispose()
      root.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose()
      })
      root.clear()
      // Textures (photos, captions, blank board) belong to the TextureFactory cache and
      // go with the track's other textures in releaseUnused().
    },
  }
}

/** Merge a few BoxGeometries (position + normal + uv) into one non-indexed geometry. */
function mergeBoxes(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  for (const g of geos) {
    const ng = g.toNonIndexed()
    positions.push(...(ng.attributes.position.array as Float32Array))
    normals.push(...(ng.attributes.normal.array as Float32Array))
    uvs.push(...(ng.attributes.uv.array as Float32Array))
    ng.dispose()
    g.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  return out
}
