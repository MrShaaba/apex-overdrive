import * as THREE from 'three'
import type { CarVisual } from '../vehicles/CarMeshBuilder'

export interface CockpitResolution {
  /** Eye position in the visual root's frame (metres; +Z forward). */
  eye: THREE.Vector3
  /** The car's own meshes to hide in cockpit view (halo bar, mirror, screen frame …). */
  hidden: THREE.Object3D[]
  /** Fraction of road-ahead rays still blocked by the car's own bodywork. */
  blocked: number
  note: string
}

// No driver sees the road 6 m ahead over a bonnet; 10 m out is the nearest point that must
// be clear, and from there to 60 m across the width of the track.
const AHEAD = [10, 18, 30, 60]
const LATERAL = [-5, -2.5, 0, 2.5, 5]
const MAX_BLOCKED = 0.1

/**
 * Works out a cockpit eye from which the road ahead is actually visible. Every licensed
 * model has its own idea of where the driver's eyes are, and from the catalog's guess the
 * nose, the halo bar or the dashboard can fill the view. Rays from the eye to points on
 * the road 6–50 m ahead, across the width of the track, are tested against the car's own
 * meshes: the eye is raised and then moved forward until fewer than 8 % are blocked, and
 * small parts still in the way (a halo pillar, a mirror, a wiper) are hidden in cockpit
 * view — the main body never is, or the car would vanish around the driver.
 */
export function resolveCockpitView(visual: CarVisual, baseEye: THREE.Vector3, bodyLength: number): CockpitResolution {
  const root = visual.root
  root.updateMatrixWorld(true)
  const exclude = new Set<THREE.Object3D>()
  for (const w of visual.wheels) w.traverse((o) => exclude.add(o))
  for (const w of visual.wheelSpin) w.traverse((o) => exclude.add(o))
  // Glass is not a blocker: a windscreen mesh stops a ray but not a driver's view.
  const seeThrough = (m: THREE.Mesh): boolean => {
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    if (/glass|window|windscreen|windshield|screen|visor/i.test(m.name + ' ' + mats.map((x) => x.name).join(' '))) return true
    return mats.some((x) => x.transparent && x.opacity < 0.95) || mats.some((x) => ((x as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0.3)
  }
  const meshes: THREE.Mesh[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && !exclude.has(o) && !visual.cockpitHidden.includes(o) && o.name !== 'cockpit-wheel' && !seeThrough(m)) meshes.push(m)
  })
  if (!meshes.length) return { eye: baseEye.clone(), hidden: [], blocked: 0, note: 'no meshes' }

  const caster = new THREE.Raycaster()
  caster.far = 4
  const eyeW = new THREE.Vector3(), target = new THREE.Vector3(), dir = new THREE.Vector3()
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(root.quaternion)
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(root.quaternion)
  const groundY = root.position.y + visual.bodyOffsetY // the model's ground plane: the road under the car

  const score = (eyeLocal: THREE.Vector3, hidden: Set<THREE.Object3D>): { blocked: number; hits: Map<THREE.Object3D, number> } => {
    const hits = new Map<THREE.Object3D, number>()
    let blocked = 0, total = 0
    eyeW.copy(eyeLocal).applyQuaternion(root.quaternion).add(root.position)
    const live = meshes.filter((m) => !hidden.has(m))
    for (const d of AHEAD) for (const l of LATERAL) {
      target.copy(root.position).addScaledVector(forward, d).addScaledVector(right, l)
      target.y = groundY
      dir.copy(target).sub(eyeW)
      const dist = dir.length()
      dir.divideScalar(dist)
      caster.set(eyeW, dir)
      caster.far = Math.min(4, dist)
      const hit = caster.intersectObjects(live, false)[0]
      total++
      if (hit) { blocked++; hits.set(hit.object, (hits.get(hit.object) ?? 0) + 1) }
    }
    return { blocked: blocked / total, hits }
  }

  const hidden = new Set<THREE.Object3D>()
  // The catalogued eye first; then a little higher (a closed car's roof is 25 cm up at most,
  // and a view from the roof is no cockpit), then forward, which is what clears a windscreen
  // frame or a roll cage's cross bar.
  const candidates: THREE.Vector3[] = [baseEye.clone()]
  for (let dy = 0.05; dy <= 0.25; dy += 0.05) candidates.push(baseEye.clone().add(new THREE.Vector3(0, dy, 0)))
  for (let dz = 0.1; dz <= 0.9; dz += 0.1) for (const dy of [0, 0.1, 0.2]) candidates.push(baseEye.clone().add(new THREE.Vector3(0, dy, dz)))

  let best = { eye: candidates[0], blocked: 1, hits: new Map<THREE.Object3D, number>() }
  for (const eye of candidates) {
    const r = score(eye, hidden)
    if (r.blocked < best.blocked) best = { eye, blocked: r.blocked, hits: r.hits }
    if (r.blocked <= MAX_BLOCKED) break
  }
  // Still blocked: hide the small parts in the way, most-hit first, never the main body.
  const box = new THREE.Box3()
  let guard = 0
  while (best.blocked > MAX_BLOCKED && guard++ < 6) {
    const [part] = [...best.hits.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
    if (!part) break
    box.setFromObject(part)
    const size = box.getSize(new THREE.Vector3())
    if (size.z > bodyLength * 0.45 || size.x > 1.6) break // the body shell itself
    hidden.add(part)
    const r = score(best.eye, hidden)
    best = { eye: best.eye, blocked: r.blocked, hits: r.hits }
  }
  const moved = best.eye.clone().sub(baseEye)
  const note = `eye ${moved.length() < 0.001 ? 'as catalogued' : `raised ${moved.y.toFixed(2)} m, forward ${moved.z.toFixed(2)} m`}, ${hidden.size} part(s) hidden, ${Math.round(best.blocked * 100)} % of the road-ahead rays blocked`
  return { eye: best.eye, hidden: [...hidden], blocked: best.blocked, note }
}
