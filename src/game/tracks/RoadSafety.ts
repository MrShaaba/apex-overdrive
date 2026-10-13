import * as THREE from 'three'
import type { PhysicsWorld } from '../physics/PhysicsWorld'
import { CollisionGroup, makeGroups } from '../physics/Surfaces'
import { TrackSpline } from './Spline'

/** Painted tarmac sometimes ships in an export's scenery/decals group. Recover
 * only near-horizontal, visible triangles at road height, never whole scenery meshes (which
 * also contain grandstands and roofs). The resulting ground exactly follows
 * visible geometry and participates in the normal seam-smoothing pass.
 */
export function visibleRoadSupport(model: THREE.Object3D, spline: TrackSpline, widthAt: (index: number) => number): THREE.BufferGeometry | null {
  const vertices: number[] = []
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const centre = new THREE.Vector3(), normal = new THREE.Vector3(), edge = new THREE.Vector3()
  model.updateMatrixWorld(true)
  for (const name of ['prop', 'prop_noshadow', 'overlay', 'overlay_noshadow']) {
    model.getObjectByName(name)?.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      if (materials.some(material => material.opacity < 0.9)) return
      const positions = object.geometry.getAttribute('position'), indices = object.geometry.index
      const count = indices?.count ?? positions.count
      for (let i = 0; i < count; i += 3) {
        a.fromBufferAttribute(positions, indices ? indices.getX(i) : i).applyMatrix4(object.matrixWorld)
        b.fromBufferAttribute(positions, indices ? indices.getX(i + 1) : i + 1).applyMatrix4(object.matrixWorld)
        c.fromBufferAttribute(positions, indices ? indices.getX(i + 2) : i + 2).applyMatrix4(object.matrixWorld)
        normal.subVectors(b, a).cross(edge.subVectors(c, a))
        if (normal.lengthSq() < 1e-8 || Math.abs(normal.normalize().y) < 0.95) continue
        centre.copy(a).add(b).add(c).multiplyScalar(1 / 3)
        const index = spline.nearestIndex(centre), sample = spline.samples[index]
        if (Math.abs(centre.y - sample.position.y) > 0.25 || Math.abs(a.y - centre.y) > 0.3 || Math.abs(b.y - centre.y) > 0.3 || Math.abs(c.y - centre.y) > 0.3) continue
        const radius = Math.min(18, widthAt(index) + 2)
        if (Math.hypot(centre.x - sample.position.x, centre.z - sample.position.z) > radius) continue
        const second = normal.y > 0 ? b : c, third = normal.y > 0 ? c : b
        vertices.push(a.x, a.y, a.z, second.x, second.y, second.z, third.x, third.y, third.z)
      }
    })
  }
  if (!vertices.length) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(Array.from({ length: vertices.length / 3 }, (_, i) => i))
  return geometry
}

/** Find a continuous car-width corridor through imported asphalt. Independent
 * nearest-lane choices can cross a pit divider or a row of cones between control
 * points. A short-step path search accounts for the car's footprint and future
 * clearance, then smooths only where the same safe corridor permits it.
 */
export function repairRoadCentreline(points: THREE.Vector3[], physics: PhysicsWorld, closed = true): { points: THREE.Vector3[]; changed: number } {
  const source = new TrackSpline(points, closed, 4)
  const rows = source.count, cols = 129, step = 0.5, middle = 64
  const R = physics.RAPIER
  const groundGroups = makeGroups(CollisionGroup.VEHICLE, CollisionGroup.GROUND)
  const wallGroups = makeGroups(CollisionGroup.VEHICLE, CollisionGroup.PROP)
  const probe = new R.Cuboid(1.2, 0.62, 2.7)
  const safe = new Uint8Array(rows * cols), costs = new Float64Array(rows * cols)
  const parents = new Int16Array(rows * cols)
  const orientation = new THREE.Quaternion()
  const index = (i: number) => closed ? ((i % rows) + rows) % rows : Math.max(0, Math.min(rows - 1, i))
  for (let i = 0; i < rows; i++) {
    const sample = source.samples[i], point = sample.position, right = sample.right
    orientation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(sample.tangent.x, sample.tangent.z))
    for (let j = 0; j < cols; j++) {
      const lat = (j - middle) * step, x = point.x + right.x * lat, z = point.z + right.z * lat
      let y = NaN
      physics.world.intersectionsWithRay(new R.Ray({ x, y: point.y + 1.5, z }, { x: 0, y: -1, z: 0 }), 3, true, hit => {
        const meta = physics.getMeta(hit.collider.handle), height = point.y + 1.5 - hit.timeOfImpact
        if (meta?.surface === 'asphalt' && !meta.wall && hit.normal.y > 0.5 && (!Number.isFinite(y) || height > y)) y = height
        return true
      }, undefined, groundGroups)
      let wall = false
      if (Number.isFinite(y)) physics.world.intersectionsWithShape({ x, y: y + 0.65, z }, orientation, probe, collider => {
        if (physics.getMeta(collider.handle)?.wall) wall = true
        return !wall
      }, undefined, wallGroups)
      safe[i * cols + j] = Number.isFinite(y) && !wall ? 1 : 0
    }
  }
  // The second pass starts near the first pass's finishing offset, preserving a
  // continuous corridor across the start/finish seam on closed circuits.
  let seam = middle, finish = middle
  for (let pass = 0; pass < (closed ? 2 : 1); pass++) {
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const at = i * cols + j, lat = (j - middle) * step
      let clearance = 0
      while (clearance < 12 && j - clearance >= 0 && j + clearance < cols && safe[i * cols + j - clearance] && safe[i * cols + j + clearance]) clearance++
      const own = safe[at] ? lat * lat * 0.006 + 1.5 / (clearance + 1) : 1e5
      if (!i) { costs[at] = own + (j - seam) ** 2 * 0.3; continue }
      let best = Infinity, previous = j
      for (let k = Math.max(0, j - 6); k <= Math.min(cols - 1, j + 6); k++) {
        const score = costs[(i - 1) * cols + k] + (j - k) ** 2 * 0.65
        if (score < best) { best = score; previous = k }
      }
      costs[at] = own + best
      parents[at] = previous
    }
    finish = 0
    for (let j = 1; j < cols; j++) if (costs[(rows - 1) * cols + j] < costs[(rows - 1) * cols + finish]) finish = j
    seam = finish
  }
  const offsets = new Float32Array(rows)
  for (let i = rows - 1, j = finish; i >= 0; i--) {
    offsets[i] = (j - middle) * step
    j = parents[i * cols + j]
  }
  for (let pass = 0; pass < 4; pass++) {
    const copy = Float32Array.from(offsets)
    for (let i = 0; i < rows; i++) {
      const proposed = (copy[index(i - 1)] + copy[i] * 2 + copy[index(i + 1)]) / 4
      const a = Math.floor(proposed / step + middle), b = Math.ceil(proposed / step + middle)
      if (a >= 0 && b < cols && safe[i * cols + a] && safe[i * cols + b]) offsets[i] = proposed
    }
  }
  let changed = 0
  const blocked = Array.from(offsets, (offset, i) => safe[i * cols + Math.round(offset / step + middle)] ? -1 : i).filter(i => i >= 0)
  if (blocked.length) console.warn(`[RoadSafety] unresolved footprint at ${blocked.slice(0, 30).map(i => Math.round(source.samples[i].distance)).join(',')}`)
  const repaired = source.samples.map((sample, i) => {
    if (Math.abs(offsets[i]) > 0.1) changed++
    // Lateral repair must not invent elevation from visual banking metadata.
    const right = sample.right.clone(); right.y = 0; right.normalize()
    return sample.position.clone().addScaledVector(right, offsets[i])
  })
  return { points: repaired, changed }
}
