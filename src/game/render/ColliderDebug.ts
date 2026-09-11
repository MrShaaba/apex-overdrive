import * as THREE from 'three'
import type { PhysicsWorld } from '../physics/PhysicsWorld'

/**
 * Draws every Rapier collider as wireframe lines over the scene (F3 in a race, or
 * `__apex.setColliderDebug(true)` from the console). Rapier's `debugRender()` hands
 * back the line list with RGBA colours: fixed colliders in one colour, dynamic in
 * another, sensors in a third — so a collider with no visible mesh shows up
 * immediately, which is how invisible kerbs on the racing surface get found.
 */
export class ColliderDebug {
  readonly lines: THREE.LineSegments
  private readonly geometry = new THREE.BufferGeometry()
  enabled = false

  constructor(private readonly physics: PhysicsWorld, scene: THREE.Scene) {
    const material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 })
    this.lines = new THREE.LineSegments(this.geometry, material)
    this.lines.name = 'collider-debug'
    this.lines.renderOrder = 10_000
    this.lines.frustumCulled = false
    this.lines.visible = false
    scene.add(this.lines)
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.lines.visible = on
    if (!on) this.geometry.setDrawRange(0, 0)
  }

  /** Rebuild the line list from the physics world; cheap enough to do every frame while on. */
  update(): void {
    if (!this.enabled) return
    const buffers = this.physics.world.debugRender()
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!pos || pos.array.length !== buffers.vertices.length) {
      this.geometry.setAttribute('position', new THREE.BufferAttribute(buffers.vertices, 3))
      this.geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 4))
    } else {
      pos.copyArray(buffers.vertices)
      pos.needsUpdate = true
      const col = this.geometry.getAttribute('color') as THREE.BufferAttribute
      col.copyArray(buffers.colors)
      col.needsUpdate = true
    }
    this.geometry.setDrawRange(0, buffers.vertices.length / 3)
  }

  dispose(): void {
    this.lines.removeFromParent()
    this.geometry.dispose()
    ;(this.lines.material as THREE.Material).dispose()
  }
}
