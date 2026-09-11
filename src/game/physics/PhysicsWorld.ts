/**
 * Rapier world wrapper.
 *
 * Responsibilities:
 *  - async WASM bootstrap (`PhysicsWorld.create()`)
 *  - fixed-step simulation with an accumulator and a clamp on catch-up steps
 *  - registry mapping collider handles → gameplay metadata (surface type,
 *    vehicle id, trigger id) so systems can decode raycasts / contact events
 *  - contact-force event draining, forwarded as vehicle collision events
 */

import RAPIER from '@dimforge/rapier3d-compat'
import { Logger } from '../core/Logger'
import type { SurfaceType } from './Surfaces'

const log = Logger.scope('Physics')

export interface ColliderMeta {
  surface?: SurfaceType
  vehicleId?: number
  trigger?: string
  hazardId?: string
  /** True for barriers/walls, used to distinguish impacts for damage/audio. */
  wall?: boolean
}

export interface ContactEvent {
  collider1: number
  collider2: number
  meta1: ColliderMeta | undefined
  meta2: ColliderMeta | undefined
  force: number
  maxForce: number
}

export const PHYSICS_STEP = 1 / 60
const MAX_CATCHUP_STEPS = 4

export class PhysicsWorld {
  readonly world: RAPIER.World
  readonly eventQueue: RAPIER.EventQueue
  private readonly meta = new Map<number, ColliderMeta>()
  private accumulator = 0
  private readonly contactListeners: ((e: ContactEvent) => void)[] = []
  /** Interpolation factor for rendering between physics steps. */
  alpha = 0
  stepsThisFrame = 0
  private disposed = false

  static async create(): Promise<PhysicsWorld> {
    const t0 = performance.now()
    await RAPIER.init()
    log.info(`Rapier initialised in ${(performance.now() - t0).toFixed(0)}ms`)
    return new PhysicsWorld()
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    this.world.timestep = PHYSICS_STEP
    this.world.integrationParameters.numSolverIterations = 6
    this.eventQueue = new RAPIER.EventQueue(true)
  }

  get RAPIER(): typeof RAPIER {
    return RAPIER
  }

  registerCollider(collider: RAPIER.Collider, meta: ColliderMeta): void {
    this.meta.set(collider.handle, meta)
  }

  unregisterCollider(handle: number): void {
    this.meta.delete(handle)
  }

  getMeta(handle: number): ColliderMeta | undefined {
    return this.meta.get(handle)
  }

  onContact(listener: (e: ContactEvent) => void): () => void {
    this.contactListeners.push(listener)
    return () => {
      const i = this.contactListeners.indexOf(listener)
      if (i >= 0) this.contactListeners.splice(i, 1)
    }
  }

  /**
   * Advance the simulation. `preStep` is invoked before each fixed step so
   * vehicle controllers can apply forces at the simulation rate rather than the
   * render rate.
   */
  update(dt: number, preStep: (stepDt: number) => void, postStep?: (stepDt: number) => void): void {
    if (this.disposed) return
    this.accumulator += Math.min(dt, 0.1)
    this.stepsThisFrame = 0
    while (this.accumulator >= PHYSICS_STEP && this.stepsThisFrame < MAX_CATCHUP_STEPS) {
      preStep(PHYSICS_STEP)
      this.world.step(this.eventQueue)
      this.drainEvents()
      postStep?.(PHYSICS_STEP)
      this.accumulator -= PHYSICS_STEP
      this.stepsThisFrame++
    }
    if (this.stepsThisFrame === MAX_CATCHUP_STEPS) this.accumulator = 0
    this.alpha = this.accumulator / PHYSICS_STEP
  }

  private drainEvents(): void {
    this.eventQueue.drainContactForceEvents((event) => {
      const c1 = event.collider1()
      const c2 = event.collider2()
      const e: ContactEvent = {
        collider1: c1,
        collider2: c2,
        meta1: this.meta.get(c1),
        meta2: this.meta.get(c2),
        force: event.totalForceMagnitude(),
        maxForce: event.maxForceMagnitude(),
      }
      for (const l of this.contactListeners) l(e)
    })
    // Collision start/stop events are drained to keep the queue bounded; triggers use intersections.
    this.eventQueue.drainCollisionEvents(() => {})
  }

  /**
   * Body scopes: everything a track (or its props/hazards) creates between
   * `beginScope()` and `endScope()` is remembered, and the disposer `endScope()` returns
   * removes whatever is still alive. Before this, a disposed track left its road,
   * walls, barriers and prop colliders in the world, so every later race drove through
   * the previous circuit's invisible geometry.
   */
  private readonly scopes: Set<RAPIER.RigidBody>[] = []

  beginScope(): void {
    this.scopes.push(new Set())
  }

  endScope(): () => void {
    const bodies = this.scopes.pop() ?? new Set<RAPIER.RigidBody>()
    return () => {
      for (const b of bodies) if (b.isValid()) this.removeBody(b)
      bodies.clear()
    }
  }

  /** Create a rigid body, remembered by the active scope (if any). */
  createBody(desc: RAPIER.RigidBodyDesc): RAPIER.RigidBody {
    const body = this.world.createRigidBody(desc)
    this.scopes[this.scopes.length - 1]?.add(body)
    return body
  }

  /** Convenience: create a static trimesh collider with surface metadata. */
  addStaticTrimesh(vertices: Float32Array, indices: Uint32Array, meta: ColliderMeta, friction = 0.9): RAPIER.Collider {
    const body = this.createBody(RAPIER.RigidBodyDesc.fixed())
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices).setFriction(friction).setRestitution(0.05)
    const collider = this.world.createCollider(desc, body)
    this.registerCollider(collider, meta)
    return collider
  }

  addStaticBox(
    halfExtents: { x: number; y: number; z: number },
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number },
    meta: ColliderMeta,
    friction = 0.6,
  ): RAPIER.Collider {
    const body = this.createBody(RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z).setRotation(rotation))
    const desc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z).setFriction(friction).setRestitution(0.2)
    const collider = this.world.createCollider(desc, body)
    this.registerCollider(collider, meta)
    return collider
  }

  removeBody(body: RAPIER.RigidBody): void {
    if (this.disposed || !body.isValid()) return
    for (let i = 0; i < body.numColliders(); i++) {
      this.meta.delete(body.collider(i).handle)
    }
    this.world.removeRigidBody(body)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.meta.clear()
    this.contactListeners.length = 0
    this.world.free()
    this.eventQueue.free()
  }
}
