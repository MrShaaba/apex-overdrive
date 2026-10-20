/**
 * Track builder: turns a `TrackDefinition` into renderable geometry, physics
 * colliders and race metadata.
 *
 *  - road ribbon with curbs, shoulders and continuous barriers (gapped where
 *    shortcuts branch off)
 *  - terrain heightmap blended to the road profile (skipped under bridges so
 *    gorges / water stay open) with a trimesh collider
 *  - tunnels (walls, ceiling, lights), bridges (deck, railings, pillars),
 *    shortcut ribbons with their own surface type, pit lane, jump ramps
 *  - start grid, checkpoints (optional where shortcuts bypass them), sector
 *    markers, trackside cinematic cameras, minimap polyline
 *  - hands scenery + hazards to `TrackProps` / `HazardSystem`
 */

import * as THREE from 'three'
import type { PhysicsWorld } from '../physics/PhysicsWorld'
import { CollisionGroup, makeGroups, type SurfaceType } from '../physics/Surfaces'
import type { TextureFactory } from '../render/TextureFactory'
import type { ResolvedQuality } from '../core/Settings'
import { clamp, fbm2D, hashString, lerp, smoothstep } from '../core/MathUtils'
import { TrackSpline } from './Spline'
import { repairRoadCentreline, visibleRoadSupport } from './RoadSafety'
import type { TrackDefinition, TrackFeature } from './TrackCatalog'
import { buildBillboards, loadPhotoSet, type BillboardsResult } from './Billboards'
import { HazardSystem } from './Hazards'
import { modelLibrary } from '../vehicles/CarModelLoader'
import { buildProps, type CrowdZone, type PropsResult } from './TrackProps'
import { Logger } from '../core/Logger'

const log = Logger.scope('Track')
const GROUND_GROUPS = makeGroups(CollisionGroup.GROUND, CollisionGroup.ALL)
const WALL_GROUPS = makeGroups(CollisionGroup.PROP, CollisionGroup.ALL)

export interface Checkpoint {
  index: number
  distance: number
  position: THREE.Vector3
  tangent: THREE.Vector3
  right: THREE.Vector3
  halfWidth: number
  required: boolean
}

export interface GridSlot {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}

export interface MinimapData {
  points: [number, number][]
  shortcuts: [number, number][][]
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  startPoint: [number, number]
}

export interface BuiltTrack {
  def: TrackDefinition
  spline: TrackSpline
  root: THREE.Group
  halfWidth: number
  /** Usable half-width at a spline sample index: per-point data for model circuits, `halfWidth` otherwise. */
  halfWidthAt: (sampleIndex: number) => number
  startGrid: GridSlot[]
  checkpoints: Checkpoint[]
  sectorDistances: number[]
  pitZone: { from: number; to: number; side: number } | null
  tunnelZones: { from: number; to: number }[]
  /**
   * DRS zones in metres of arc length, auto-detected on the longest
   * low-curvature stretches. A zone with from > to wraps the start line.
   */
  drsZones: { from: number; to: number }[]
  crowdZones: CrowdZone[]
  tracksideCameras: THREE.Vector3[]
  hazards: HazardSystem
  props: PropsResult
  /** Photo billboards, when the definition asks for them. */
  billboards: BillboardsResult | null
  minimap: MinimapData
  terrainHeight(x: number, z: number): number
  spawnPose(distance: number, lateral?: number): GridSlot
  setWeatherVisual(wetness: number, snow: number, nightFactor: number): void
  update(dt: number, cameraPos: THREE.Vector3, drawDistance: number, time: number): void
  dispose(): void
}

interface RibbonOptions {
  halfWidthAt: (i: number) => number
  offsetAt?: (i: number) => number
  lift?: number
  uvScale?: number
  from?: number
  to?: number
}

/** Sweep a flat ribbon along spline samples. Returns geometry with UVs. */
function buildRibbon(spline: TrackSpline, opts: RibbonOptions): THREE.BufferGeometry {
  const from = opts.from ?? 0
  const to = opts.to ?? spline.count - (spline.closed ? 0 : 1)
  const positions: number[] = []
  const uvs: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const lift = opts.lift ?? 0
  const uvScale = opts.uvScale ?? 1
  let n = 0
  for (let i = from; i <= to; i++) {
    const s = spline.sampleAt(i)
    const hw = opts.halfWidthAt(i)
    const off = opts.offsetAt ? opts.offsetAt(i) : 0
    const l = s.position.clone().addScaledVector(s.right, off - hw).addScaledVector(s.up, lift)
    const r = s.position.clone().addScaledVector(s.right, off + hw).addScaledVector(s.up, lift)
    positions.push(l.x, l.y, l.z, r.x, r.y, r.z)
    normals.push(s.up.x, s.up.y, s.up.z, s.up.x, s.up.y, s.up.z)
    const v = (s.distance / (hw * 2 || 1)) * uvScale
    uvs.push(0, v, 1, v)
    if (n > 0) {
      const a = (n - 1) * 2
      // Winding chosen so the face normal points along the sample's up vector.
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
    n++
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(indices)
  g.computeBoundingSphere()
  return g
}

/** Ribbon between two lateral offsets with different vertical lifts (used for shoulder skirts). */
function buildSkirt(spline: TrackSpline, innerOffset: number, outerOffset: number, innerLift: number, outerLift: number, enabled: (i: number) => boolean): THREE.BufferGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const to = spline.count - (spline.closed ? 0 : 1)
  let n = 0
  for (let i = 0; i <= to; i++) {
    const s = spline.sampleAt(i)
    const on = enabled(i)
    const a = s.position.clone().addScaledVector(s.right, innerOffset).addScaledVector(s.up, innerLift)
    const b = s.position.clone().addScaledVector(s.right, on ? outerOffset : innerOffset).addScaledVector(s.up, on ? outerLift : innerLift)
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z)
    const v = s.distance / 8
    uvs.push(0, v, 1, v)
    if (n > 0) {
      const k = (n - 1) * 2
      indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
    }
    n++
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}

/** Scenery placeholder for circuit models, which carry their own props. */
function emptyProps(): PropsResult {
  return { root: new THREE.Group(), crowdZones: [], lampPositions: [], updateVisibility() {}, setNight() {}, dispose() {} }
}

/**
 * Static trimesh collider, split into spatial chunks. A circuit model's road,
 * walls or terrain is one mesh spanning the whole lap; as a single collider its
 * bounding box covers the circuit, so every wheel ray and chassis pair test
 * from every car traverses every such mesh. Chunked, the broadphase only hands
 * a car the few pieces around it — the difference between 15 and 90 fps with
 * an eight-car field on a 7 km track.
 */
function addTrimeshCollider(physics: PhysicsWorld, geometry: THREE.BufferGeometry, surface: SurfaceType, groups = GROUND_GROUPS, wall = false, chunk = 100): void {
  const pos = geometry.attributes.position.array as Float32Array
  const idx = geometry.index ? new Uint32Array(geometry.index.array) : undefined
  if (!idx) return
  const body = physics.createBody(physics.RAPIER.RigidBodyDesc.fixed())
  const cells = new Map<number, number[]>()
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const cx = Math.floor((pos[a] + pos[b] + pos[c]) / 3 / chunk)
    const cz = Math.floor((pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3 / chunk)
    const key = (cx + 32768) * 65536 + (cz + 32768)
    let list = cells.get(key)
    if (!list) cells.set(key, (list = []))
    list.push(t)
  }
  for (const tris of cells.values()) {
    const remap = new Map<number, number>()
    const verts: number[] = []
    const local = new Uint32Array(tris.length * 3)
    let k = 0
    for (const t of tris) {
      for (let e = 0; e < 3; e++) {
        const v = idx[t + e]
        let m = remap.get(v)
        if (m === undefined) {
          m = verts.length / 3
          remap.set(v, m)
          verts.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2])
        }
        local[k++] = m
      }
    }
    // Weld adjacent triangle normals so low formula-car floors cannot catch
    // internal edges on a visually continuous racing surface.
    const desc = physics.RAPIER.ColliderDesc.trimesh(new Float32Array(verts), local, wall ? undefined : physics.RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
      .setFriction(0.9).setRestitution(0).setCollisionGroups(groups)
    const col = physics.world.createCollider(desc, body)
    physics.registerCollider(col, { surface, wall })
  }
}

export async function buildTrack(def: TrackDefinition, physics: PhysicsWorld, textures: TextureFactory, quality: ResolvedQuality, onProgress?: (fraction: number) => void): Promise<BuiltTrack> {
  physics.beginScope()
  try {
    const track = await buildTrackContents(def, physics, textures, quality, onProgress)
    const releaseBodies = physics.endScope()
    const disposeVisuals = track.dispose
    track.dispose = () => { disposeVisuals(); releaseBodies() }
    return track
  } catch (error) {
    // A failed build must never leave invisible colliders in the next session.
    physics.endScope()()
    throw error
  }
}

async function buildTrackContents(def: TrackDefinition, physics: PhysicsWorld, textures: TextureFactory, quality: ResolvedQuality, onProgress?: (fraction: number) => void): Promise<BuiltTrack> {
  const t0 = performance.now()
  const root = new THREE.Group()
  root.name = `track-${def.id}`
  const env = def.environment
  const points = def.points.map(([x, y, z]) => new THREE.Vector3(x, y, z))
  let spline = new TrackSpline(points, def.closed, 2)
  const halfWidth = def.width / 2
  const catalogHalfWidthAt = (() => {
    const hw = def.halfWidths
    if (!hw || !hw.length) return () => halfWidth
    // Control points and spline samples are both uniform in arc length, so the index maps proportionally.
    return (i: number) => hw[Math.min(hw.length - 1, Math.round((spline.wrapIndex(i) / spline.count) * hw.length))]
  })()
  let safeHalfWidths: Float32Array | null = null
  const halfWidthAt = (index: number): number => safeHalfWidths?.[spline.wrapIndex(index)] ?? catalogHalfWidthAt(index)
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = []
  const bounds = spline.bounds()
  const seed = hashString(def.id)

  // Licensed circuit: the file supplies road, terrain, walls and scenery and
  // the procedural surfaces/terrain/props are skipped. A missing file falls
  // back to the procedural build around the same centreline.
  const modelTemplate = def.model && (await modelLibrary.preload(def.model.file, onProgress)) ? modelLibrary.get(def.model.file) : null
  if (def.model && !modelTemplate) log.warn(`${def.name}: circuit model ${def.model.file} unavailable — building it procedurally`)
  const useModel = modelTemplate !== null

  // Feature lookups.
  const tunnels = def.features.filter((f): f is Extract<TrackFeature, { type: 'tunnel' }> => f.type === 'tunnel')
  const bridges = def.features.filter((f): f is Extract<TrackFeature, { type: 'bridge' }> => f.type === 'bridge')
  const shortcuts = def.features.filter((f): f is Extract<TrackFeature, { type: 'shortcut' }> => f.type === 'shortcut')
  const pits = def.features.filter((f): f is Extract<TrackFeature, { type: 'pit' }> => f.type === 'pit')
  const jumps = def.features.filter((f): f is Extract<TrackFeature, { type: 'jump' }> => f.type === 'jump')
  const inRange = (t: number, from: number, to: number) => t >= from && t <= to
  const inTunnel = (t: number) => tunnels.some((f) => inRange(t, f.from, f.to))
  const onBridge = (t: number) => bridges.some((f) => inRange(t, f.from, f.to))

  // Shortcut splines (built early: terrain + props need them).
  const shortcutSplines = shortcuts.map((sc) => ({ feature: sc, spline: new TrackSpline(sc.points.map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, 2), halfWidth: (sc.width ?? 8) / 2 }))

  // ---------------------------------------------------------------------------
  // Terrain height function
  // ---------------------------------------------------------------------------
  const amp = env.terrainAmplitude
  const baseHeight = (x: number, z: number): number => {
    const f = fbm2D(x / 420, z / 420, 4, seed)
    const g = fbm2D(x / 90 + 7, z / 90 - 3, 3, seed + 5) * 0.25
    let h = (f + g) * amp
    switch (env.terrain) {
      case 'island': {
        const c = bounds.getCenter(new THREE.Vector3())
        const d = Math.hypot(x - c.x, z - c.z)
        h = h * 0.6 + 14 - d * 0.055 // island falls into the sea away from centre
        break
      }
      case 'canyon':
        h = Math.abs(h) * 1.6 + 6
        break
      case 'mountain':
        h = h * 1.4 + 20
        break
      case 'valley':
        h = h * 0.7
        break
      case 'city':
      case 'flat':
        h = h * 0.15
        break
    }
    return h
  }
  const proceduralTerrainHeight = (x: number, z: number): number => {
    const p = new THREE.Vector3(x, 0, z)
    const i = spline.nearestIndex(p)
    const s = spline.samples[i]
    const dx = x - s.position.x
    const dz = z - s.position.z
    const lateral = Math.abs(dx * s.right.x + dz * s.right.z)
    const along = Math.abs(dx * s.tangent.x + dz * s.tangent.z)
    const dist = along > 4 ? Math.hypot(dx, dz) : lateral
    let h = baseHeight(x, z)
    // Shortcut blending.
    for (const sc of shortcutSplines) {
      const j = sc.spline.nearestIndex(p)
      const ss = sc.spline.samples[j]
      const d = Math.hypot(x - ss.position.x, z - ss.position.z)
      const blend = 1 - smoothstep(sc.halfWidth + 2, sc.halfWidth + 18, d)
      if (blend > 0) h = lerp(h, ss.position.y - 1.0, blend)
    }
    if (onBridge(s.t)) {
      // Under a bridge the ground drops away (gorge / water).
      const drop = env.waterLevel !== null ? env.waterLevel - 3 : s.position.y - 18 - amp * 0.3
      const blend = 1 - smoothstep(halfWidth + 6, halfWidth + 40, dist)
      return lerp(h, Math.min(h, drop), blend)
    }
    // Sink the terrain a metre under the road corridor; the shoulder + skirt ribbons cover the seam.
    const corridor = halfWidth + 16
    const blend = 1 - smoothstep(corridor, corridor + 30, dist)
    return lerp(h, s.position.y - 1.0, blend)
  }
  // Circuit models ship a flat terrain plane at y = 0.
  const terrainHeight = useModel ? (): number => 0 : proceduralTerrainHeight
  // Plan-view distance: nearestIndex measures in 3-D and a point at y = 0 reads as far
  // from an elevated shortcut, which put scenery on it.
  const shortcutClearance = (x: number, z: number): number => {
    let best = Infinity
    for (const sc of shortcutSplines) {
      for (const ss of sc.spline.samples) best = Math.min(best, Math.hypot(x - ss.position.x, z - ss.position.z) - sc.halfWidth)
    }
    return best
  }

  // ---------------------------------------------------------------------------
  // Licensed circuit model: road, terrain, walls and scenery from the file
  // ---------------------------------------------------------------------------
  let roadMat: THREE.MeshStandardMaterial | null = null
  let puddleMat: THREE.MeshPhysicalMaterial | null = null
  let snowMat: THREE.MeshStandardMaterial | null = null
  let shoulderMat: THREE.MeshStandardMaterial | null = null
  let modelRoadRoughness = 0.88
  if (modelTemplate) {
    const model = modelTemplate.clone(true)
    model.name = 'track-model'
    root.add(model)
    const mount = (name: string, surface: SurfaceType | null, wall: boolean, cast: boolean) => {
      const node = model.getObjectByName(name)
      if (!node) return
      node.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return
        o.castShadow = cast
        o.receiveShadow = true
        // Per-track material clones: weather tinting must not touch the cached template.
        const mats = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => (m as THREE.Material).clone())
        o.material = mats.length === 1 ? mats[0] : mats
        disposables.push(...mats)
        if (name === 'road' && !roadMat && mats[0] instanceof THREE.MeshStandardMaterial) {
          roadMat = mats[0]
          modelRoadRoughness = roadMat.roughness
        }
        if (name.startsWith('overlay')) for (const m of mats) { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2 }
        if (surface) addTrimeshCollider(physics, o.geometry, surface, wall ? WALL_GROUPS : GROUND_GROUPS, wall)
      })
    }
    // Node classes baked by prepare-track.mjs (each may also come as <class>_noshadow).
    const classes: [string, SurfaceType | null, boolean, boolean][] = [
      ['road', 'asphalt', false, false],
      ['kerb', 'curb', false, false],
      ['pit', 'asphalt', false, false],
      ['runoff', 'concrete', false, false],
      ['gravel', 'gravel', false, false],
      ['terrain', 'grass', false, false],
      ['wall', 'concrete', true, true],
      ['overlay', null, false, false],
      ['prop', null, false, true],
    ]
    for (const [name, surface, wall, cast] of classes) {
      mount(name, surface, wall, cast)
      mount(`${name}_noshadow`, surface, wall, false)
    }
    const support = visibleRoadSupport(model, spline, catalogHalfWidthAt)
    if (support) {
      addTrimeshCollider(physics, support, 'asphalt')
      support.dispose()
    }
    // Exported road meshes can extend under barrier feet. Measure the actual
    // barriers so the AI and grid do not mistake that geometry for usable lane.
    physics.world.updateSceneQueries()
    const repaired = repairRoadCentreline(points, physics, def.closed)
    if (repaired.changed) {
      spline = new TrackSpline(repaired.points, def.closed, 2)
      log.info(`${def.name}: repaired ${repaired.changed} centreline points with insufficient barrier clearance`)
    }
    safeHalfWidths = new Float32Array(spline.count)
    for (let i = 0; i < spline.count; i++) {
      const sample = spline.samples[i]
      let width = catalogHalfWidthAt(i)
      for (const side of [-1, 1]) for (const height of [0.1, 0.35, 0.9]) {
        const ray = new physics.RAPIER.Ray(
          { x: sample.position.x, y: sample.position.y + height, z: sample.position.z },
          { x: sample.right.x * side, y: 0, z: sample.right.z * side },
        )
        const hit = physics.world.castRay(ray, width, true, undefined, makeGroups(CollisionGroup.VEHICLE, CollisionGroup.PROP), undefined, undefined,
          (collider) => physics.getMeta(collider.handle)?.wall === true)
        if (hit && hit.timeOfImpact > 1) width = Math.min(width, Math.max(1.2, hit.timeOfImpact - 0.25))
      }
      const footprint = new physics.RAPIER.Cuboid(0.25, 0.65, 3)
      const orientation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(sample.tangent.x, sample.tangent.z))
      for (const side of [-1, 1]) for (let lateral = 1; lateral <= width; lateral += 0.5) {
        const x = sample.position.x + sample.right.x * side * lateral, z = sample.position.z + sample.right.z * side * lateral
        let blocked = false
        physics.world.intersectionsWithShape({ x, y: sample.position.y + 0.65, z }, orientation, footprint, collider => {
          if (physics.getMeta(collider.handle)?.wall) blocked = true
          return !blocked
        }, undefined, makeGroups(CollisionGroup.VEHICLE, CollisionGroup.PROP))
        if (blocked) { width = Math.min(width, Math.max(1.2, lateral - 0.25)); break }
      }
      safeHalfWidths[i] = width
    }
    // A wide grass apron under and beyond the model's terrain so a car that
    // runs off the map never falls through the world.
    const centre = bounds.getCenter(new THREE.Vector3())
    const apronGeo = new THREE.PlaneGeometry(8000, 8000, 1, 1)
    apronGeo.rotateX(-Math.PI / 2)
    apronGeo.translate(centre.x, bounds.min.y - 1.5, centre.z)
    const apronTex = textures.ground('grass', env.groundColor)
    apronTex.repeat.set(400, 400)
    const apronMat = new THREE.MeshStandardMaterial({ map: apronTex, roughness: 0.98 })
    const apron = new THREE.Mesh(apronGeo, apronMat)
    apron.receiveShadow = true
    root.add(apron)
    addTrimeshCollider(physics, apronGeo, 'grass')
    disposables.push(apronGeo, apronMat)

    // Smoothing net: an invisible asphalt collider 5 mm *above* the asphalt as
    // the physics actually sees it. Circuit models are rough in ways a car at
    // 250 km/h cannot take: racing-groove decals 3–8 cm above the base asphalt,
    // drain strips and painted patches a few centimetres low, seams and missing
    // slivers — and a formula car under downforce runs its floor on the road, so
    // every edge catches. Sampled at every spline sample and every metre across
    // and interpolated, the net is the one continuous sheet the wheels and floor
    // meet on asphalt; steps become ramps, gaps get covered. Columns over kerbs,
    // grass or gravel take their nearest asphalt neighbour's height but sit 5 mm
    // *below* their own surface, so kerbs still bite and a lower verge stays grass.
    {
      const R = physics.RAPIER
      // Colliders created since the last step are invisible to ray queries until
      // the query pipeline is refreshed.
      physics.world.updateSceneQueries()
      const rayGroups = makeGroups(CollisionGroup.VEHICLE, CollisionGroup.GROUND)
      const lats: number[] = []
      for (let l = -8; l <= 8; l++) lats.push(l)
      const rows = spline.samples.length
      const cols = lats.length
      const heights = new Float32Array(rows * cols)
      const onAsphalt = new Uint8Array(rows * cols)
      const ownTop = new Float32Array(cols)
      const ownSurface: (SurfaceType | null)[] = new Array(cols).fill(null)
      const hits: { y: number; surface: SurfaceType }[] = []
      for (let i = 0; i < rows; i++) {
        const s = spline.samples[i]
        for (let j = 0; j < cols; j++) {
          const x = s.position.x + s.right.x * lats[j]
          const z = s.position.z + s.right.z * lats[j]
          const top = s.position.y + 30
          hits.length = 0
          physics.world.intersectionsWithRay(new R.Ray({ x, y: top, z }, { x: 0, y: -1, z: 0 }), 60, true, (h) => {
            const meta = physics.getMeta(h.collider.handle)
            const y = top - h.timeOfImpact
            // A deck or roof classed as road must not become the net: nothing more than
            // 2 m from the spline's own height counts (banking within ±8 m stays under that).
            if (meta?.surface && !meta.wall && Math.abs(y - s.position.y) < 2) hits.push({ y, surface: meta.surface })
            return true
          }, undefined, rayGroups)
          hits.sort((a, b) => b.y - a.y)
          // A terrain sheet laid over the road inside the road's own width (Suzuka's first
          // corner has grass 5–20 cm above the asphalt) is a modelling artefact, not a verge:
          // the net rides on top of it as asphalt. Beyond the half-width a raised verge stays.
          if (hits.length && hits[0].surface !== 'asphalt' && Math.abs(lats[j]) < halfWidthAt(i) - 0.5) {
            const asphaltBelow = hits.find((h) => h.surface === 'asphalt')
            if (asphaltBelow && hits[0].y - asphaltBelow.y < 0.3) hits[0] = { y: hits[0].y, surface: 'asphalt' }
          }
          ownTop[j] = hits.length ? hits[0].y : NaN
          ownSurface[j] = hits.length ? hits[0].surface : null
          heights[i * cols + j] = hits.length && hits[0].surface === 'asphalt' ? hits[0].y : NaN
          onAsphalt[i * cols + j] = hits.length && hits[0].surface === 'asphalt' ? 1 : 0
        }
        // Read the original asphalt samples when bridging a gap. Reusing a
        // previously filled column propagates the outside-bank height across
        // the road and produces a metre-high ridge on banked ovals.
        const asphaltHeights = heights.slice(i * cols, (i + 1) * cols)
        for (let j = 0; j < cols; j++) {
          if (Number.isFinite(asphaltHeights[j])) continue
          let left = j - 1, right = j + 1
          while (left >= 0 && !Number.isFinite(asphaltHeights[left])) left--
          while (right < cols && !Number.isFinite(asphaltHeights[right])) right++
          const ref = left >= 0 && right < cols
            ? lerp(asphaltHeights[left], asphaltHeights[right], (j - left) / (right - left))
            : left >= 0 ? asphaltHeights[left] : right < cols ? asphaltHeights[right] : s.position.y
          const own = ownTop[j], surface = ownSurface[j]
          if (!Number.isFinite(own)) heights[i * cols + j] = ref // a gap: cover it
          else if ((surface === 'concrete' || surface === 'curb') && own > ref - 0.1) heights[i * cols + j] = ref // paint, drain covers, kerb feet: road
          else heights[i * cols + j] = Math.min(ref, own) // verges, gravel, deep drops: stay below them
        }
      }
      const verts = new Float32Array(rows * cols * 3)
      for (let i = 0; i < rows; i++) {
        const s = spline.samples[i]
        for (let j = 0; j < cols; j++) {
          const o = (i * cols + j) * 3
          verts[o] = s.position.x + s.right.x * lats[j]
          verts[o + 1] = heights[i * cols + j] + (onAsphalt[i * cols + j] ? 0.005 : -0.005)
          verts[o + 2] = s.position.z + s.right.z * lats[j]
        }
      }
      const rowCount = def.closed ? rows : rows - 1
      const index = new Uint32Array(rowCount * (cols - 1) * 6)
      let k = 0
      for (let i = 0; i < rowCount; i++) {
        const a = i * cols, b = ((i + 1) % rows) * cols
        for (let j = 0; j < cols - 1; j++) {
          index[k++] = a + j; index[k++] = b + j; index[k++] = a + j + 1
          index[k++] = a + j + 1; index[k++] = b + j; index[k++] = b + j + 1
        }
      }
      const netGeo = new THREE.BufferGeometry()
      netGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
      netGeo.setIndex(new THREE.BufferAttribute(index, 1))
      addTrimeshCollider(physics, netGeo, 'asphalt')
      netGeo.dispose()
    }
    // Hole net: circuit exports have gaps between meshes and ground that never got
    // geometry (logos painted on nothing, run-off sheets that stop short of the terrain).
    // Beyond the smoothing net a coarse invisible grass sheet follows the real ground
    // 30 cm below it and bridges holes 30 cm under the spline, so a car that leaves the
    // road drops centimetres onto grass instead of fifteen metres onto the apron.
    {
      const R = physics.RAPIER
      physics.world.updateSceneQueries()
      const rayGroups = makeGroups(CollisionGroup.VEHICLE, CollisionGroup.GROUND)
      const lats: number[] = []
      for (let l = -44; l <= 44; l += 4) lats.push(l)
      const rowIdx: number[] = []
      for (let i = 0; i < spline.samples.length; i += 2) rowIdx.push(i)
      const rows = rowIdx.length, cols = lats.length
      const verts = new Float32Array(rows * cols * 3)
      let holes = 0
      for (let r = 0; r < rows; r++) {
        const s = spline.samples[rowIdx[r]]
        for (let j = 0; j < cols; j++) {
          const x = s.position.x + s.right.x * lats[j], z = s.position.z + s.right.z * lats[j]
          const top = s.position.y + 40
          let ground = NaN
          physics.world.intersectionsWithRay(new R.Ray({ x, y: top, z }, { x: 0, y: -1, z: 0 }), 80, true, (h) => {
            const meta = physics.getMeta(h.collider.handle)
            const y = top - h.timeOfImpact
            if (meta?.surface && !meta.wall && Math.abs(y - s.position.y) < 8 && !(ground >= y)) ground = y
            return true
          }, undefined, rayGroups)
          if (!Number.isFinite(ground)) holes++
          const o = (r * cols + j) * 3
          verts[o] = x
          // Under the road the sheet stays well clear (the smoothing net owns that); beyond it
          // sits 8 cm under the ground so the lip of a hole is a step a car can climb, not a trap.
          verts[o + 1] = (Number.isFinite(ground) ? ground : s.position.y) - (Math.abs(lats[j]) <= 12 ? 0.3 : 0.08)
          verts[o + 2] = z
        }
      }
      const rowCount = def.closed ? rows : rows - 1
      const index: number[] = []
      const aPoint = new THREE.Vector3(), bPoint = new THREE.Vector3(), cPoint = new THREE.Vector3()
      const normal = new THREE.Vector3(), edge = new THREE.Vector3()
      const addTriangle = (a: number, b: number, c: number) => {
        aPoint.fromArray(verts, a * 3); bPoint.fromArray(verts, b * 3); cPoint.fromArray(verts, c * 3)
        normal.subVectors(bPoint, aPoint).cross(edge.subVectors(cPoint, aPoint)).normalize()
        // A coarse net must never connect an overpass to the lower road with an
        // invisible ramp. Real steep terrain already has its own visible collider.
        if (Math.abs(normal.y) < 0.9) return
        if (Math.max(aPoint.y, bPoint.y, cPoint.y) - Math.min(aPoint.y, bPoint.y, cPoint.y) > 0.3) {
          for (const [u, v] of [[aPoint, bPoint], [bPoint, cPoint], [cPoint, aPoint]]) {
            const x = (u.x + v.x) / 2, y = (u.y + v.y) / 2, z = (u.z + v.z) / 2
            let crossesRoad = false
            physics.world.intersectionsWithRay(new R.Ray({ x, y: y + 0.04, z }, { x: 0, y: -1, z: 0 }), 8, true, hit => {
              if (physics.getMeta(hit.collider.handle)?.surface === 'asphalt' && hit.timeOfImpact > 0.09) crossesRoad = true
              return !crossesRoad
            }, undefined, rayGroups)
            if (crossesRoad) return
          }
        }
        index.push(a, b, c)
      }
      for (let r = 0; r < rowCount; r++) {
        const a = r * cols, b = ((r + 1) % rows) * cols
        for (let j = 0; j < cols - 1; j++) {
          addTriangle(a + j, b + j, a + j + 1)
          addTriangle(a + j + 1, b + j, b + j + 1)
        }
      }
      const holeGeo = new THREE.BufferGeometry()
      holeGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
      holeGeo.setIndex(index)
      addTrimeshCollider(physics, holeGeo, 'grass')
      holeGeo.dispose()
      if (holes) console.info(`[Track] hole net bridged ${holes} of ${rows * cols} cells with no ground under them`)
    }
  }

  // ---------------------------------------------------------------------------
  // Road surfaces (procedural circuits)
  // ---------------------------------------------------------------------------
  if (!useModel) {
  const roadTex = textures.road(env.roadColor)
  roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.88, metalness: 0.02, color: 0xffffff })
  const roadGeo = buildRibbon(spline, { halfWidthAt: () => halfWidth, lift: 0.02, uvScale: 1 })
  const road = new THREE.Mesh(roadGeo, roadMat)
  road.receiveShadow = true
  road.name = 'road'
  root.add(road)
  addTrimeshCollider(physics, roadGeo, 'asphalt')
  disposables.push(roadGeo, roadMat)

  // Puddle overlay (visible when wet).
  puddleMat = new THREE.MeshPhysicalMaterial({ color: 0x0b0f14, roughness: 0.03, metalness: 0.1, transparent: true, opacity: 0, envMapIntensity: 2.2, clearcoat: 1, clearcoatRoughness: 0.02, depthWrite: false })
  puddleMat.alphaMap = textures.get('puddles', (ctx, size, rng) => {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, size, size)
    for (let i = 0; i < 26; i++) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
      g.addColorStop(0, 'rgba(255,255,255,1)')
      g.addColorStop(0.7, 'rgba(255,255,255,0.8)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.save()
      ctx.translate(rng() * size, rng() * size)
      ctx.scale(size * (0.05 + rng() * 0.12), size * (0.02 + rng() * 0.05))
      ctx.fillStyle = g
      ctx.fillRect(-1, -1, 2, 2)
      ctx.restore()
    }
  }, { size: 512, repeat: [1, 6], srgb: false })
  const puddles = new THREE.Mesh(roadGeo, puddleMat)
  puddles.position.y = 0.015
  puddles.renderOrder = 2
  root.add(puddles)
  disposables.push(puddleMat)

  // Snow overlay on the road (tinted white plane over asphalt).
  snowMat = new THREE.MeshStandardMaterial({ color: 0xf2f5f9, roughness: 0.95, transparent: true, opacity: 0, depthWrite: false })
  const snowOverlay = new THREE.Mesh(roadGeo, snowMat)
  snowOverlay.position.y = 0.012
  snowOverlay.renderOrder = 1
  root.add(snowOverlay)
  disposables.push(snowMat)

  // Curbs on corners.
  const curbMat = new THREE.MeshStandardMaterial({ map: textures.curb(), roughness: 0.7 })
  disposables.push(curbMat)
  {
    const curbGeoms: THREE.BufferGeometry[] = []
    let start = -1
    const n = spline.count
    const pushSeg = (a: number, b: number, side: number) => {
      if (b - a < 3) return
      const g = buildRibbon(spline, { halfWidthAt: () => 0.7, offsetAt: () => side * (halfWidth + 0.55), lift: 0.05, uvScale: 0.5, from: a, to: b })
      curbGeoms.push(g)
    }
    for (const side of [-1, 1]) {
      start = -1
      for (let i = 0; i < n; i++) {
        const s = spline.samples[i]
        const corner = Math.abs(s.curvature) > 0.0045 && !inTunnel(s.t)
        if (corner && start < 0) start = i
        if ((!corner || i === n - 1) && start >= 0) {
          pushSeg(start, i, side)
          start = -1
        }
      }
    }
    for (const g of curbGeoms) {
      const m = new THREE.Mesh(g, curbMat)
      m.receiveShadow = true
      root.add(m)
      addTrimeshCollider(physics, g, 'curb')
      disposables.push(g)
    }
  }

  // Shoulders (run-off).
  const shoulderKind: SurfaceType = env.snow ? 'snow' : def.theme === 'island' ? 'sand' : def.theme === 'badlands' ? 'dirt' : def.theme === 'metro' || def.theme === 'neon' || def.theme === 'shipyard' ? 'concrete' : 'grass'
  const shoulderTexKind = shoulderKind === 'concrete' ? 'concrete' : shoulderKind === 'snow' ? 'snow' : shoulderKind === 'sand' ? 'sand' : shoulderKind === 'dirt' ? 'dirt' : 'grass'
  shoulderMat = new THREE.MeshStandardMaterial({ map: textures.ground(shoulderTexKind, env.groundColor), roughness: 0.98 })
  shoulderMat.map!.repeat.set(2, 60)
  const shoulderGeo = buildRibbon(spline, { halfWidthAt: () => 7, lift: -0.02, uvScale: 1 })
  // We need left and right shoulders: use offsets.
  disposables.push(shoulderGeo)
  // Inner shoulder (flat run-off) then an outer skirt that slopes down to meet the sunken terrain.
  for (const side of [-1, 1]) {
    // Starts under the road edge so there is never a gap between asphalt and run-off.
    const flat = buildRibbon(spline, { halfWidthAt: (i) => (onBridge(spline.sampleAt(i).t) ? 0.01 : 4.35), offsetAt: () => side * (halfWidth - 0.3 + 4.35), lift: -0.03, uvScale: 1 })
    const skirtGeo = buildSkirt(spline, side * (halfWidth + 8.2), side * (halfWidth + 17), -0.03, -1.0, (i) => !onBridge(spline.sampleAt(i).t))
    for (const g of [flat, skirtGeo]) {
      const m = new THREE.Mesh(g, shoulderMat)
      m.receiveShadow = true
      root.add(m)
      addTrimeshCollider(physics, g, shoulderKind)
      disposables.push(g)
    }
  }
  disposables.push(shoulderMat)
  } // end procedural road surfaces

  // ---------------------------------------------------------------------------
  // Barriers (continuous, gapped for shortcuts and pit entries)
  // ---------------------------------------------------------------------------
  const isUrban = def.theme === 'metro' || def.theme === 'neon' || def.theme === 'shipyard'
  const barrierMat = new THREE.MeshStandardMaterial({ color: isUrban ? 0xbfc3c9 : 0xd8dbe0, roughness: 0.6, metalness: isUrban ? 0.1 : 0.6, side: THREE.DoubleSide })
  const barrierStripe = new THREE.MeshStandardMaterial({ color: 0xe0202c, roughness: 0.6 })
  disposables.push(barrierMat, barrierStripe)
  const gapAt = (t: number, side: number): boolean => {
    for (const sc of shortcuts) {
      const scSide = Math.sign(spline.lateralOffset(new THREE.Vector3(...sc.points[1]), spline.atT(sc.entry).distance / 2 | 0)) || 1
      if (scSide === side && (Math.abs(t - sc.entry) < 0.012 || Math.abs(t - sc.exit) < 0.012)) return true
    }
    for (const p of pits) if (p.side === side && (Math.abs(t - p.from) < 0.01 || Math.abs(t - p.to) < 0.01 || (t > p.from && t < p.to))) return true
    return false
  }
  if (!useModel) {
    const barrierHeight = 1.0
    const offset = halfWidth + 6.0
    const segs = 5 // samples per barrier segment (10 m)
    const positions: number[] = []
    const indices: number[] = []
    const stripePositions: number[] = []
    const stripeIndices: number[] = []
    for (const side of [-1, 1]) {
      for (let i = 0; i < spline.count - (spline.closed ? 0 : segs); i += segs) {
        const s0 = spline.sampleAt(i)
        const s1 = spline.sampleAt(i + segs)
        if (gapAt(s0.t, side) || inTunnel(s0.t)) continue
        const off = onBridge(s0.t) ? halfWidth + 0.9 : offset
        const off1 = onBridge(s1.t) ? halfWidth + 0.9 : offset
        const a = s0.position.clone().addScaledVector(s0.right, side * off)
        const b = s1.position.clone().addScaledVector(s1.right, side * off1)
        a.y = onBridge(s0.t) ? s0.position.y : Math.max(terrainHeight(a.x, a.z), s0.position.y - 0.4)
        b.y = onBridge(s1.t) ? s1.position.y : Math.max(terrainHeight(b.x, b.z), s1.position.y - 0.4)
        const base = positions.length / 3
        const thick = 0.35
        const n = s0.right.clone().multiplyScalar(side * thick)
        // 8 vertices box-ish (front/back faces).
        for (const p of [a, b]) {
          positions.push(p.x - n.x, p.y - 0.3, p.z - n.z, p.x - n.x, p.y + barrierHeight, p.z - n.z, p.x + n.x, p.y + barrierHeight, p.z + n.z, p.x + n.x, p.y - 0.3, p.z + n.z)
        }
        // Faces: inner (0,1) outer(2,3) top(1,2)
        const q = (o0: number, o1: number) => indices.push(base + o0, base + o1, base + 4 + o0, base + o1, base + 4 + o1, base + 4 + o0)
        q(0, 1)
        q(1, 2)
        q(2, 3)
        q(3, 0)
        // Stripe.
        const sb = stripePositions.length / 3
        for (const p of [a, b]) stripePositions.push(p.x - n.x * 1.03, p.y + 0.35, p.z - n.z * 1.03, p.x - n.x * 1.03, p.y + 0.65, p.z - n.z * 1.03)
        stripeIndices.push(sb, sb + 1, sb + 2, sb + 1, sb + 3, sb + 2)
        // Collider.
        const mid = a.clone().add(b).multiplyScalar(0.5)
        const len = a.distanceTo(b)
        const dir = b.clone().sub(a).normalize()
        const yaw = Math.atan2(dir.x, dir.z)
        const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
        physics.addStaticBox({ x: thick, y: barrierHeight * 0.5 + 0.4, z: len / 2 + 0.2 }, { x: mid.x, y: mid.y + barrierHeight * 0.35, z: mid.z }, { x: qy.x, y: qy.y, z: qy.z, w: qy.w }, { wall: true, surface: 'concrete' }, 0.3)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    g.setIndex(indices)
    g.computeVertexNormals()
    const m = new THREE.Mesh(g, barrierMat)
    m.castShadow = true
    m.receiveShadow = true
    root.add(m)
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.Float32BufferAttribute(stripePositions, 3))
    sg.setIndex(stripeIndices)
    sg.computeVertexNormals()
    const sm = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ color: 0xe0202c, roughness: 0.6, side: THREE.DoubleSide }))
    root.add(sm)
    disposables.push(g, sg, sm.material as THREE.Material)
  }

  // ---------------------------------------------------------------------------
  // Terrain mesh + collider
  // ---------------------------------------------------------------------------
  if (!useModel) {
    const margin = 700
    const minX = bounds.min.x - margin
    const maxX = bounds.max.x + margin
    const minZ = bounds.min.z - margin
    const maxZ = bounds.max.z + margin
    const res = quality.propDensity >= 1 ? 220 : 170
    const geo = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ, res, res)
    geo.rotateX(-Math.PI / 2)
    geo.translate((minX + maxX) / 2, 0, (minZ + maxZ) / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(pos.count * 3)
    const ground = new THREE.Color(env.groundColor)
    const rock = new THREE.Color(env.terrain === 'canyon' ? 0x8d5233 : 0x6b6e73)
    const snowC = new THREE.Color(0xeef2f6)
    const sandC = new THREE.Color(0xd9c38a)
    const tmp = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const h = terrainHeight(x, z)
      pos.setY(i, h)
      // Vertex colour by slope/height.
      const slope = Math.abs(terrainHeight(x + 3, z) - h) + Math.abs(terrainHeight(x, z + 3) - h)
      tmp.copy(ground)
      if (slope > 2.2) tmp.lerp(rock, clamp((slope - 2.2) / 3, 0, 1))
      if (env.snow || (env.terrain === 'mountain' && h > 110)) tmp.lerp(snowC, env.snow ? 0.9 : clamp((h - 110) / 30, 0, 1))
      if (env.waterLevel !== null && h < env.waterLevel + 2.5) tmp.lerp(sandC, clamp((env.waterLevel + 2.5 - h) / 2.5, 0, 1))
      tmp.multiplyScalar(0.9 + fbm2D(x / 30, z / 30, 2, seed + 9) * 0.12)
      colors[i * 3] = tmp.r
      colors[i * 3 + 1] = tmp.g
      colors[i * 3 + 2] = tmp.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()
    const terrainTex = textures.ground(env.snow ? 'snow' : env.terrain === 'canyon' ? 'dirt' : env.terrain === 'city' || env.terrain === 'flat' ? 'concrete' : 'grass', '#9a9a9a')
    terrainTex.repeat.set(160, 160)
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: terrainTex, roughness: 0.98 })
    const terrain = new THREE.Mesh(geo, mat)
    terrain.receiveShadow = true
    terrain.name = 'terrain'
    root.add(terrain)
    addTrimeshCollider(physics, geo, env.snow ? 'snow' : env.terrain === 'canyon' ? 'dirt' : env.terrain === 'city' || env.terrain === 'flat' ? 'concrete' : 'grass')
    disposables.push(geo, mat)
  }

  // ---------------------------------------------------------------------------
  // Tunnels
  // ---------------------------------------------------------------------------
  const tunnelZones: { from: number; to: number }[] = []
  for (const tn of tunnels) {
    const from = Math.floor(tn.from * spline.count)
    const to = Math.floor(tn.to * spline.count)
    tunnelZones.push({ from: spline.sampleAt(from).distance, to: spline.sampleAt(to).distance })
    const style = tn.style ?? 'concrete'
    const color = style === 'rock' ? 0x6a5a4c : style === 'ice' ? 0xcfe3f5 : style === 'neon' ? 0x1a1630 : style === 'steel' ? 0x5a6168 : 0x8b8f94
    const wallMat = new THREE.MeshStandardMaterial({ color, roughness: style === 'ice' ? 0.2 : 0.9, metalness: style === 'steel' ? 0.6 : 0, side: THREE.DoubleSide, flatShading: style === 'rock' })
    const wallH = 6.5
    const wallOff = halfWidth + 1.6
    // Left wall, right wall, ceiling as ribbons (vertical ribbons built manually).
    const build = (side: number) => {
      const positions: number[] = []
      const indices: number[] = []
      let n = 0
      for (let i = from; i <= to; i++) {
        const s = spline.sampleAt(i)
        const jitter = style === 'rock' ? (fbm2D(i * 0.3, side, 2, seed) * 1.2) : 0
        const base = s.position.clone().addScaledVector(s.right, side * (wallOff + jitter))
        positions.push(base.x, base.y - 0.5, base.z, base.x + s.right.x * side * jitter * 0.5, base.y + wallH, base.z + s.right.z * side * jitter * 0.5)
        if (n > 0) {
          const a = (n - 1) * 2
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
        }
        n++
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      g.setIndex(indices)
      g.computeVertexNormals()
      const m = new THREE.Mesh(g, wallMat)
      m.receiveShadow = true
      root.add(m)
      addTrimeshCollider(physics, g, 'concrete', WALL_GROUPS, true)
      disposables.push(g)
    }
    build(-1)
    build(1)
    const ceilGeo = buildRibbon(spline, { halfWidthAt: () => wallOff + 1, lift: wallH, from, to })
    const ceil = new THREE.Mesh(ceilGeo, wallMat)
    root.add(ceil)
    disposables.push(ceilGeo, wallMat)
    // Outer hull so the tunnel reads as a solid structure from outside.
    const hullGeo = buildRibbon(spline, { halfWidthAt: () => wallOff + 4, lift: wallH + 3, from, to })
    const hull = new THREE.Mesh(hullGeo, new THREE.MeshStandardMaterial({ color: style === 'ice' ? 0xdde9f5 : 0x5f5a55, roughness: 1 }))
    hull.castShadow = true
    root.add(hull)
    disposables.push(hullGeo, hull.material as THREE.Material)
    // Lights.
    const lightMat = new THREE.MeshStandardMaterial({ color: style === 'neon' ? 0xff2d95 : 0xfff2d0, emissive: style === 'neon' ? 0xff2d95 : 0xffe9b0, emissiveIntensity: 2.5 })
    disposables.push(lightMat)
    for (let i = from; i < to; i += 8) {
      const s = spline.sampleAt(i)
      const strip = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 1.4, 0.12, 0.5), lightMat)
      strip.position.copy(s.position).addScaledVector(s.up, wallH - 0.2)
      strip.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(s.tangent.x, s.tangent.z))
      root.add(strip)
      disposables.push(strip.geometry)
    }
  }

  // ---------------------------------------------------------------------------
  // Bridges
  // ---------------------------------------------------------------------------
  for (const br of bridges) {
    const from = Math.floor(br.from * spline.count)
    const to = Math.floor(br.to * spline.count)
    const style = br.style ?? 'concrete'
    const deckMat = new THREE.MeshStandardMaterial({ color: style === 'wood' ? 0x7a5a3a : style === 'steel' ? 0x5c6672 : 0x9a9ea6, roughness: 0.8, metalness: style === 'steel' ? 0.5 : 0 })
    const railMat = new THREE.MeshStandardMaterial({ color: style === 'wood' ? 0x5a3f2a : 0xb8bec7, roughness: 0.5, metalness: style === 'wood' ? 0 : 0.7 })
    disposables.push(deckMat, railMat)
    // Deck underside.
    const deckGeo = buildRibbon(spline, { halfWidthAt: () => halfWidth + 1.5, lift: -1.2, from, to })
    const deck = new THREE.Mesh(deckGeo, deckMat)
    deck.castShadow = true
    root.add(deck)
    disposables.push(deckGeo)
    // Side fascia.
    for (const side of [-1, 1]) {
      const positions: number[] = []
      const indices: number[] = []
      let n = 0
      for (let i = from; i <= to; i++) {
        const s = spline.sampleAt(i)
        const p = s.position.clone().addScaledVector(s.right, side * (halfWidth + 1.5))
        positions.push(p.x, p.y - 1.2, p.z, p.x, p.y + 0.15, p.z)
        if (n > 0) {
          const a = (n - 1) * 2
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
        }
        n++
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      g.setIndex(indices)
      g.computeVertexNormals()
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: deckMat.color, roughness: 0.8, side: THREE.DoubleSide }))
      root.add(m)
      disposables.push(g, m.material as THREE.Material)
      // Railing posts + rail.
      for (let i = from; i <= to; i += 4) {
        const s = spline.sampleAt(i)
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), railMat)
        post.position.copy(s.position).addScaledVector(s.right, side * (halfWidth + 0.9)).addScaledVector(s.up, 0.55)
        root.add(post)
        disposables.push(post.geometry)
      }
      const railGeo = buildRibbon(spline, { halfWidthAt: () => 0.08, offsetAt: () => side * (halfWidth + 0.9), lift: 1.1, from, to })
      const rail = new THREE.Mesh(railGeo, railMat)
      rail.material.side = THREE.DoubleSide
      root.add(rail)
      disposables.push(railGeo)
    }
    // Pillars.
    for (let i = from; i <= to; i += 12) {
      const s = spline.sampleAt(i)
      const ground = terrainHeight(s.position.x, s.position.z)
      const floor = env.waterLevel !== null ? Math.min(ground, env.waterLevel - 6) : ground
      const h = Math.max(2, s.position.y - 1.2 - floor)
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(style === 'causeway' ? 3 : 2.2, h, halfWidth * (style === 'causeway' ? 1.2 : 0.8)), deckMat)
      pillar.position.copy(s.position)
      pillar.position.y = floor + h / 2
      pillar.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(s.tangent.x, s.tangent.z))
      pillar.castShadow = true
      root.add(pillar)
      disposables.push(pillar.geometry)
    }
    if (style === 'steel') {
      // Arch trusses.
      for (const side of [-1, 1]) {
        const positions: number[] = []
        for (let i = from; i <= to; i += 2) {
          const s = spline.sampleAt(i)
          const u = (i - from) / Math.max(1, to - from)
          const arch = Math.sin(u * Math.PI) * 9
          const p = s.position.clone().addScaledVector(s.right, side * (halfWidth + 1.4)).addScaledVector(s.up, arch)
          positions.push(p.x, p.y, p.z)
        }
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x8a94a0 }))
        root.add(line)
        disposables.push(g, line.material as THREE.Material)
        for (let i = from; i <= to; i += 10) {
          const s = spline.sampleAt(i)
          const u = (i - from) / Math.max(1, to - from)
          const arch = Math.sin(u * Math.PI) * 9
          if (arch < 0.5) continue
          const strut = new THREE.Mesh(new THREE.BoxGeometry(0.25, arch, 0.25), railMat)
          strut.position.copy(s.position).addScaledVector(s.right, side * (halfWidth + 1.4)).addScaledVector(s.up, arch / 2)
          root.add(strut)
          disposables.push(strut.geometry)
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Shortcuts
  // ---------------------------------------------------------------------------
  const minimapShortcuts: [number, number][][] = []
  for (const sc of shortcutSplines) {
    const kind = sc.feature.surface
    const texKind = kind === 'sand' ? 'sand' : kind === 'gravel' ? 'gravel' : kind === 'dirt' ? 'dirt' : kind === 'snow' ? 'snow' : kind === 'concrete' ? 'concrete' : 'asphalt'
    const mat = new THREE.MeshStandardMaterial({ map: textures.ground(texKind, kind === 'sand' ? '#d9c38a' : kind === 'gravel' ? '#8a8378' : kind === 'dirt' ? '#8a6a48' : kind === 'snow' ? '#e8eef4' : kind === 'concrete' ? '#8f9196' : env.roadColor), roughness: 0.95 })
    mat.map!.repeat.set(1, 30)
    const geo = buildRibbon(sc.spline, { halfWidthAt: () => sc.halfWidth, lift: 0.03, uvScale: 1 })
    const m = new THREE.Mesh(geo, mat)
    m.receiveShadow = true
    root.add(m)
    addTrimeshCollider(physics, geo, kind)
    disposables.push(geo, mat)
    for (const side of [-1, 1]) {
      const skirt = buildSkirt(sc.spline, side * sc.halfWidth, side * (sc.halfWidth + 9), 0.0, -1.0, () => true)
      const sm = new THREE.Mesh(skirt, mat)
      sm.receiveShadow = true
      root.add(sm)
      addTrimeshCollider(physics, skirt, kind)
      disposables.push(skirt)
    }
    minimapShortcuts.push(sc.spline.samples.filter((_, i) => i % 3 === 0).map((s) => [s.position.x, s.position.z]))
  }

  // ---------------------------------------------------------------------------
  // Pit lane
  // ---------------------------------------------------------------------------
  let pitZone: BuiltTrack['pitZone'] = null
  for (const p of pits) {
    const from = Math.floor(p.from * spline.count)
    const to = Math.floor(p.to * spline.count)
    if (useModel) {
      // The model brings its own pit asphalt and garages; only the zone is needed.
      pitZone = { from: spline.sampleAt(from).distance, to: spline.sampleAt(to).distance, side: p.side }
      continue
    }
    const off = halfWidth + 5.5
    const geo = buildRibbon(spline, { halfWidthAt: () => 4, offsetAt: () => p.side * off, lift: 0.03, from, to })
    const mat = new THREE.MeshStandardMaterial({ map: textures.ground('concrete', '#7c7f85'), roughness: 0.9 })
    const m = new THREE.Mesh(geo, mat)
    m.receiveShadow = true
    root.add(m)
    addTrimeshCollider(physics, geo, 'concrete')
    disposables.push(geo, mat)
    // Pit building + boxes.
    const bMat = new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.7 })
    const sign = new THREE.MeshStandardMaterial({ color: 0xffd60a, emissive: 0xffd60a, emissiveIntensity: 0.8 })
    disposables.push(bMat, sign)
    for (let i = from + 4; i < to - 4; i += 12) {
      const s = spline.sampleAt(i)
      const box = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 22), bMat)
      box.position.copy(s.position).addScaledVector(s.right, p.side * (off + 7.5)).addScaledVector(s.up, 2)
      box.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(s.tangent.x, s.tangent.z))
      box.castShadow = true
      box.receiveShadow = true
      root.add(box)
      disposables.push(box.geometry)
      const sg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.8, 6), sign)
      sg.position.copy(box.position).addScaledVector(s.right, -p.side * 3.05).addScaledVector(s.up, 1.2)
      sg.quaternion.copy(box.quaternion)
      root.add(sg)
      disposables.push(sg.geometry)
    }
    pitZone = { from: spline.sampleAt(from).distance, to: spline.sampleAt(to).distance, side: p.side }
  }

  // ---------------------------------------------------------------------------
  // DRS zones — auto-detected on the longest low-curvature stretches so every
  // track gets sensible straights without per-track data.
  // ---------------------------------------------------------------------------
  const drsZones: { from: number; to: number }[] = []
  {
    const flat = spline.samples.map((s) => Math.abs(s.curvature) < 0.0055)
    const runs: { start: number; len: number }[] = []
    let runStart = -1
    for (let i = 0; i < flat.length; i++) {
      if (flat[i] && runStart < 0) runStart = i
      else if (!flat[i] && runStart >= 0) {
        runs.push({ start: runStart, len: i - runStart })
        runStart = -1
      }
    }
    if (runStart >= 0) runs.push({ start: runStart, len: flat.length - runStart })
    // On a closed lap the main straight usually spans the start line — merge
    // the runs touching both ends into one wrapping run.
    const last = runs[runs.length - 1]
    if (def.closed && runs.length > 1 && runs[0].start === 0 && last.start + last.len === flat.length) {
      runs.pop()
      runs[0] = { start: last.start, len: last.len + runs[0].len }
    }
    runs.sort((a, b) => b.len - a.len)
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x17d068, emissive: 0x17d068, emissiveIntensity: 0.55, roughness: 0.5 })
    disposables.push(stripeMat)
    const sampleSpacing = spline.length / spline.count
    for (const r of runs.slice(0, 2)) {
      if (r.len * sampleSpacing < 150) continue
      const fromIdx = (r.start + 12) % spline.count
      const toIdx = (r.start + r.len - 3) % spline.count
      drsZones.push({ from: spline.sampleAt(fromIdx).distance, to: spline.sampleAt(toIdx).distance })
      // Painted activation line across the road at the zone start.
      const a = Math.min(fromIdx, spline.count - 3)
      const geo = buildRibbon(spline, { halfWidthAt: () => halfWidth, lift: 0.035, from: a, to: a + 2 })
      const stripe = new THREE.Mesh(geo, stripeMat)
      root.add(stripe)
      disposables.push(geo)
    }
  }

  // Smooth, spline-following crests. A tilted box left a 31 cm vertical
  // entrance: low formula noses struck it like an invisible wall. Both ends
  // now meet the asphalt with zero slope, and the mesh is the collider.
  for (const j of jumps) {
    const centre = spline.atT(j.at).distance
    const length = 40, height = 0.35, segments = 80
    const positions: number[] = [], uvs: number[] = [], indices: number[] = []
    for (let i = 0; i <= segments; i++) {
      const t = i / segments
      const sample = spline.atDistance(centre + (t - 0.5) * length)
      const lift = height * Math.sin(Math.PI * t) ** 2 + 0.005
      for (const side of [-1, 1]) {
        const point = sample.position.clone().addScaledVector(sample.right, side * (halfWidth - 0.15)).addScaledVector(sample.up, lift)
        positions.push(point.x, point.y, point.z)
        uvs.push((side + 1) / 2, t * 4)
      }
      if (i > 0) {
        const n = (i - 1) * 2
        indices.push(n, n + 2, n + 1, n + 1, n + 2, n + 3)
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    const material = new THREE.MeshStandardMaterial({ color: 0x444951, roughness: 0.85 })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'road-crest'
    mesh.receiveShadow = true
    root.add(mesh)
    disposables.push(geometry, material)
    addTrimeshCollider(physics, geometry, 'asphalt')
  }

  // Start / finish gantry (circuit models carry their own start lights and line).
  if (!useModel) {
    const s = spline.atDistance(0)
    const yaw = Math.atan2(s.tangent.x, s.tangent.z)
    const gMat = new THREE.MeshStandardMaterial({ color: 0xe8eaf0, roughness: 0.5, metalness: 0.3 })
    const bannerMat = new THREE.MeshStandardMaterial({ map: textures.neonSign('APEX OVERDRIVE', '#ff6a00'), emissive: 0xffffff, emissiveMap: textures.neonSign('APEX OVERDRIVE', '#ff6a00'), emissiveIntensity: 0.6, side: THREE.DoubleSide })
    disposables.push(gMat, bannerMat)
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 8, 0.6), gMat)
      post.position.copy(s.position).addScaledVector(s.right, side * (halfWidth + 1.5)).addScaledVector(s.up, 4)
      root.add(post)
      disposables.push(post.geometry)
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2 + 3.6, 1.6, 0.8), gMat)
    beam.position.copy(s.position).addScaledVector(s.up, 7.6)
    beam.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    root.add(beam)
    disposables.push(beam.geometry)
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(halfWidth * 2, 1.4), bannerMat)
    banner.position.copy(s.position).addScaledVector(s.up, 7.6).addScaledVector(s.tangent, -0.45)
    banner.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI)
    root.add(banner)
    disposables.push(banner.geometry)
    // Start line paint.
    const lineGeo = buildRibbon(spline, { halfWidthAt: () => halfWidth, lift: 0.03, from: 0, to: 1 })
    const line = new THREE.Mesh(lineGeo, new THREE.MeshStandardMaterial({ map: textures.get('checker', (ctx, size) => { const n = 8; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { ctx.fillStyle = (x + y) % 2 ? '#111' : '#eee'; ctx.fillRect((x * size) / n, (y * size) / n, size / n, size / n) } }, { size: 128, repeat: [8, 1] }), roughness: 0.8 }))
    root.add(line)
    disposables.push(lineGeo, line.material as THREE.Material)
  }

  // ---------------------------------------------------------------------------
  // Race metadata
  // ---------------------------------------------------------------------------
  const spawnPose = (distance: number, lateral = 0): GridSlot => {
    const s = spline.atDistance(distance)
    const margin = Math.max(0, halfWidthAt(spline.nearestIndex(s.position)) - 1.5)
    const position = s.position.clone().addScaledVector(s.right, clamp(lateral, -margin, margin))
    position.y += 0.9
    // Matrix4.lookAt(eye, target, up) builds a frame whose +Z axis points from target to eye,
    // so aiming at -tangent makes the car's +Z (forward) point along the track direction.
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), s.tangent.clone().negate(), new THREE.Vector3(0, 1, 0)))
    return { position, quaternion }
  }
  const startGrid: GridSlot[] = []
  for (let i = 0; i < 14; i++) {
    const row = Math.floor(i / 2)
    const col = i % 2 === 0 ? -1 : 1
    const d = def.closed ? -(12 + row * 7.5 + (col > 0 ? 3 : 0)) : 14 + row * 7.5 + (col > 0 ? 3 : 0)
    startGrid.push(spawnPose(def.closed ? spline.length + d : d, col * halfWidth * 0.42))
  }

  const checkpoints: Checkpoint[] = []
  const cpSpacing = 90
  const cpCount = Math.max(4, Math.floor(spline.length / cpSpacing))
  for (let i = 0; i < cpCount; i++) {
    const d = (i / cpCount) * spline.length
    const s = spline.atDistance(d)
    const t = d / spline.length
    const bypassed = shortcuts.some((sc) => t > sc.entry + 0.01 && t < sc.exit - 0.01)
    checkpoints.push({ index: i, distance: d, position: s.position.clone(), tangent: s.tangent.clone(), right: s.right.clone(), halfWidth: halfWidth + 8, required: !bypassed })
  }
  const sectorDistances = def.features.filter((f) => f.type === 'sector').map((f) => (f as { at: number }).at * spline.length)

  const tracksideCameras: THREE.Vector3[] = []
  for (let d = 60, k = 0; d < spline.length; d += 170, k++) {
    const s = spline.atDistance(d)
    const side = k % 2 === 0 ? 1 : -1
    const p = s.position.clone().addScaledVector(s.right, side * (halfWidth + 9 + (k % 3) * 3))
    p.y = Math.max(terrainHeight(p.x, p.z) + 2.5, s.position.y + 3 + (k % 3) * 2)
    tracksideCameras.push(p)
  }

  // Scenery + hazards (a circuit model brings its own scenery).
  // No redistributable scenery library ships yet, so procedural props are used (see tools/asset-pipeline/prepare-props.mjs).
  const propLibrary = null
  const props = useModel ? emptyProps() : buildProps(def, spline, halfWidth, terrainHeight, textures, physics, quality.propDensity, bounds, shortcutClearance, propLibrary)
  root.add(props.root)
  const hazards = new HazardSystem(physics, textures)
  for (const f of def.features) if (f.type === 'hazard') hazards.add(f, spline, halfWidth, terrainHeight)
  root.add(hazards.root)

  // Photo billboards (opt-in per definition). The set is fetched here so a missing
  // manifest simply means blank boards.
  let billboards: BillboardsResult | null = null
  if (def.photoBillboards) {
    const set = await loadPhotoSet(def.photoBillboards.set)
    billboards = buildBillboards(def, def.photoBillboards, set, spline, halfWidthAt, textures, physics, { pitZone, tunnelZones, onBridge, sceneRoot: root })
    root.add(billboards.root)
  }

  const minimapPoints: [number, number][] = spline.samples.filter((_, i) => i % 3 === 0).map((s) => [s.position.x, s.position.z])
  const mb = { minX: bounds.min.x, maxX: bounds.max.x, minZ: bounds.min.z, maxZ: bounds.max.z }

  log.info(`Built ${def.name} in ${(performance.now() - t0).toFixed(0)}ms — ${spline.length.toFixed(0)} m, ${checkpoints.length} checkpoints`)

  return {
    def,
    spline,
    root,
    halfWidth,
    halfWidthAt,
    startGrid,
    checkpoints,
    sectorDistances,
    pitZone,
    tunnelZones,
    drsZones,
    crowdZones: props.crowdZones,
    tracksideCameras,
    hazards,
    props,
    billboards,
    minimap: { points: minimapPoints, shortcuts: minimapShortcuts, bounds: mb, startPoint: [spline.samples[0].position.x, spline.samples[0].position.z] },
    terrainHeight,
    spawnPose,
    setWeatherVisual(wetness, snow, nightFactor) {
      if (roadMat) {
        roadMat.roughness = (useModel ? modelRoadRoughness : 0.88) - wetness * 0.62
        roadMat.metalness = 0.02 + wetness * 0.12
        roadMat.color.setScalar(1 - wetness * 0.35)
        roadMat.envMapIntensity = 1 + wetness * 1.5
      }
      if (puddleMat) puddleMat.opacity = wetness * 0.85
      if (snowMat) snowMat.opacity = snow * 0.85
      if (shoulderMat) shoulderMat.color.setScalar(1 - wetness * 0.25)
      props.setNight(nightFactor)
      billboards?.setNight(nightFactor)
    },
    update(dt, cameraPos, drawDistance, time) {
      hazards.update(dt)
      props.updateVisibility(cameraPos, drawDistance, time)
      billboards?.updateVisibility(cameraPos, drawDistance)
    },
    dispose() {
      hazards.dispose()
      props.dispose()
      billboards?.dispose()
      for (const d of disposables) d.dispose()
      root.clear()
    },
  }
}
