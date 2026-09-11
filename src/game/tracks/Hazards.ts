/**
 * Moving / changing track hazards. Each hazard owns kinematic or dynamic Rapier
 * bodies plus a visual, and is driven by the race clock so cycles are
 * deterministic per track.
 */

import * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import type { PhysicsWorld } from '../physics/PhysicsWorld'
import { CollisionGroup, makeGroups } from '../physics/Surfaces'
import type { TrackFeature } from './TrackCatalog'
import type { TrackSpline } from './Spline'
import type { TextureFactory } from '../render/TextureFactory'

type HazardFeature = Extract<TrackFeature, { type: 'hazard' }>

interface Hazard {
  id: string
  update(dt: number, time: number): void
  dispose(): void
}

const HAZARD_GROUPS = makeGroups(CollisionGroup.HAZARD, CollisionGroup.ALL)

export class HazardSystem {
  readonly root = new THREE.Group()
  private hazards: Hazard[] = []
  private time = 0
  readonly R: typeof RAPIER

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly textures: TextureFactory,
  ) {
    this.R = physics.RAPIER
    this.root.name = 'hazards'
  }

  add(feature: HazardFeature, spline: TrackSpline, halfWidth: number, terrainHeight: (x: number, z: number) => number): void {
    const s = spline.atT(feature.at)
    const id = `${feature.kind}-${feature.at.toFixed(2)}`
    const period = feature.period ?? 15
    const side = feature.side ?? 1
    const { R, physics } = this
    const root = new THREE.Group()
    this.root.add(root)

    const kinematicBox = (size: THREE.Vector3, color: number, meta = { hazardId: id, wall: true }) => {
      const body = physics.createBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(s.position.x, s.position.y, s.position.z))
      const col = physics.world.createCollider(R.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2).setCollisionGroups(HAZARD_GROUPS).setFriction(0.4), body)
      physics.registerCollider(col, meta)
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.5 }))
      mesh.castShadow = true
      mesh.receiveShadow = true
      root.add(mesh)
      return { body, mesh }
    }
    const setKinematic = (body: RAPIER.RigidBody, mesh: THREE.Object3D, pos: THREE.Vector3, quat: THREE.Quaternion) => {
      body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z })
      body.setNextKinematicRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
      mesh.position.copy(pos)
      mesh.quaternion.copy(quat)
    }
    const yaw = Math.atan2(s.tangent.x, s.tangent.z)
    const alongRight = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI / 2)
    const bodies: RAPIER.RigidBody[] = []
    const dispose = () => {
      for (const b of bodies) physics.removeBody(b)
      this.root.remove(root)
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          ;(o.material as THREE.Material).dispose()
        }
      })
    }

    switch (feature.kind) {
      case 'train':
      case 'carts':
      case 'truck': {
        const isTrain = feature.kind === 'train'
        const isTruck = feature.kind === 'truck'
        const size = isTrain ? new THREE.Vector3(3.2, 4, 46) : isTruck ? new THREE.Vector3(2.8, 3.6, 16) : new THREE.Vector3(2, 1.8, 12)
        const { body, mesh } = kinematicBox(size, isTrain ? 0x2b4b7a : isTruck ? 0x7a3a1c : 0x555a60)
        bodies.push(body)
        if (isTrain) {
          const win = new THREE.Mesh(new THREE.BoxGeometry(3.3, 1.2, 44), new THREE.MeshStandardMaterial({ color: 0xffe8a0, emissive: 0xffd070, emissiveIntensity: 0.8 }))
          win.position.y = 0.8
          mesh.add(win)
        }
        // Rails / crossing visual.
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 120), new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.8, roughness: 0.4 }))
        for (const off of [-0.75, 0.75]) {
          const r = rail.clone()
          r.position.copy(s.position).addScaledVector(s.tangent, off)
          r.position.y += 0.06
          r.quaternion.copy(alongRight)
          root.add(r)
        }
        const travel = 130
        const crossTime = isTrain ? period * 0.45 : period * 0.55
        this.hazards.push({
          id,
          update: (_dt, time) => {
            const t = (time % period) / crossTime
            const x = t < 1 ? -travel / 2 + t * travel : travel * 2
            const pos = s.position.clone().addScaledVector(s.right, x)
            pos.y = s.position.y + size.y / 2 + 0.05
            setKinematic(body, mesh, pos, alongRight)
          },
          dispose,
        })
        break
      }
      case 'crane': {
        const size = new THREE.Vector3(2.4, 2.4, 6)
        const { body, mesh } = kinematicBox(size, 0xd04a1c)
        bodies.push(body)
        ;(mesh.material as THREE.MeshStandardMaterial).map = this.textures.container('#d04a1c')
        // Gantry.
        const gantryMat = new THREE.MeshStandardMaterial({ color: 0xf2c11c, metalness: 0.5, roughness: 0.5 })
        const beam = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2 + 30, 1.2, 1.2), gantryMat)
        beam.position.copy(s.position).addScaledVector(s.up, 16)
        beam.quaternion.copy(alongRight)
        root.add(beam)
        for (const sd of [-1, 1]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(1, 16, 1), gantryMat)
          leg.position.copy(s.position).addScaledVector(s.right, sd * (halfWidth + 14)).addScaledVector(s.up, 8)
          root.add(leg)
        }
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 14), new THREE.MeshStandardMaterial({ color: 0x222222 }))
        root.add(cable)
        const q = new THREE.Quaternion()
        this.hazards.push({
          id,
          update: (_dt, time) => {
            const phase = (time / period) * Math.PI * 2
            const x = Math.sin(phase) * (halfWidth + 6)
            const pos = s.position.clone().addScaledVector(s.right, x)
            pos.y = s.position.y + 1.3 + Math.abs(Math.cos(phase)) * 0.3
            q.copy(alongRight)
            setKinematic(body, mesh, pos, q)
            cable.position.copy(pos).addScaledVector(s.up, 7)
            cable.lookAt(beam.position)
            cable.rotateX(Math.PI / 2)
          },
          dispose,
        })
        break
      }
      case 'gate': {
        const len = halfWidth * 0.95
        const size = new THREE.Vector3(0.3, 1.0, len)
        const { body, mesh } = kinematicBox(size, 0xffffff)
        bodies.push(body)
        ;(mesh.material as THREE.MeshStandardMaterial).map = this.textures.curb()
        const pivot = s.position.clone().addScaledVector(s.right, side * (halfWidth + 0.5))
        pivot.y += 0.9
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 2.2, 10), new THREE.MeshStandardMaterial({ color: 0x333333 }))
        post.position.copy(pivot)
        root.add(post)
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8), new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff2020, emissiveIntensity: 2 }))
        lamp.position.copy(pivot).addScaledVector(s.up, 1.3)
        root.add(lamp)
        const q = new THREE.Quaternion()
        const axis = new THREE.Vector3(0, 1, 0)
        this.hazards.push({
          id,
          update: (_dt, time) => {
            const cycle = (time % period) / period
            // Closed for the middle 35% of the cycle.
            const closed = cycle > 0.3 && cycle < 0.65
            const target = closed ? 0 : 1
            const swing = cycle < 0.3 ? Math.min(1, (0.3 - cycle) / 0.08) : cycle > 0.65 ? Math.min(1, (cycle - 0.65) / 0.08) : 0
            const open = closed ? 0 : Math.max(target, swing)
            const angle = open * (Math.PI / 2)
            // Arm rotates from across-road (angle 0) to along-road.
            q.copy(alongRight).multiply(new THREE.Quaternion().setFromAxisAngle(axis, -side * angle))
            const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
            const center = pivot.clone().addScaledVector(dir, -side * len * 0.5)
            setKinematic(body, mesh, center, q)
            ;(lamp.material as THREE.MeshStandardMaterial).emissiveIntensity = closed ? 3 : 0.3
          },
          dispose,
        })
        break
      }
      case 'rockfall':
      case 'avalanche':
      case 'bales': {
        const isSnow = feature.kind === 'avalanche'
        const isBale = feature.kind === 'bales'
        const radius = isBale ? 0.7 : isSnow ? 0.9 : 1.1
        const mat = new THREE.MeshStandardMaterial({ color: isSnow ? 0xe8f0f8 : isBale ? 0xc9a34a : 0x6f5a48, roughness: 0.95 })
        const geo = isBale ? new THREE.CylinderGeometry(radius, radius, 1.4, 14) : new THREE.IcosahedronGeometry(radius, 1)
        const active: { body: RAPIER.RigidBody; mesh: THREE.Mesh; age: number }[] = []
        let nextSpawn = period * 0.3
        const spawnSide = side || (Math.random() > 0.5 ? 1 : -1)
        const spawn = () => {
          const count = isSnow ? 4 : 1
          for (let i = 0; i < count; i++) {
            const start = s.position.clone().addScaledVector(s.right, spawnSide * (halfWidth + 8 + Math.random() * 3)).addScaledVector(s.tangent, (Math.random() - 0.5) * 12)
            start.y = Math.max(start.y, terrainHeight(start.x, start.z)) + 6 + Math.random() * 4
            const body = physics.createBody(R.RigidBodyDesc.dynamic().setTranslation(start.x, start.y, start.z).setLinvel(-spawnSide * s.right.x * 9, 0, -spawnSide * s.right.z * 9).setAngularDamping(0.5))
            const col = physics.world.createCollider((isBale ? R.ColliderDesc.cylinder(0.7, radius) : R.ColliderDesc.ball(radius)).setDensity(isSnow ? 200 : isBale ? 150 : 600).setFriction(0.8).setRestitution(0.2).setCollisionGroups(HAZARD_GROUPS), body)
            physics.registerCollider(col, { hazardId: id })
            const mesh = new THREE.Mesh(geo, mat)
            mesh.castShadow = true
            root.add(mesh)
            active.push({ body, mesh, age: 0 })
          }
        }
        this.hazards.push({
          id,
          update: (dt, time) => {
            nextSpawn -= dt
            if (nextSpawn <= 0 && active.length < 6) {
              spawn()
              nextSpawn = period * (0.8 + Math.random() * 0.4)
            }
            void time
            for (let i = active.length - 1; i >= 0; i--) {
              const a = active[i]
              a.age += dt
              const t = a.body.translation()
              const r = a.body.rotation()
              a.mesh.position.set(t.x, t.y, t.z)
              a.mesh.quaternion.set(r.x, r.y, r.z, r.w)
              if (a.age > 14 || t.y < -50) {
                physics.removeBody(a.body)
                root.remove(a.mesh)
                active.splice(i, 1)
              }
            }
          },
          dispose: () => {
            for (const a of active) physics.removeBody(a.body)
            geo.dispose()
            mat.dispose()
            dispose()
          },
        })
        break
      }
      case 'ice':
      case 'fountain': {
        const isIce = feature.kind === 'ice'
        const span = feature.span ?? 40
        // A surface-only patch: a sensor whose top sits 5 mm above the road so the wheel rays
        // read ice/water first, but nothing to push a chassis — the old 4 cm cuboid was a kerb.
        const body = physics.createBody(R.RigidBodyDesc.fixed().setTranslation(s.position.x, s.position.y - 0.015, s.position.z).setRotation({ x: alongRight.x, y: alongRight.y, z: alongRight.z, w: alongRight.w }))
        const col = physics.world.createCollider(R.ColliderDesc.cuboid(halfWidth, 0.02, span / 2).setSensor(true).setCollisionGroups(makeGroups(CollisionGroup.GROUND, CollisionGroup.ALL)).setFriction(0.2), body)
        physics.registerCollider(col, { surface: isIce ? 'ice' : 'water', hazardId: id })
        bodies.push(body)
        const patch = new THREE.Mesh(
          new THREE.PlaneGeometry(halfWidth * 2, span),
          new THREE.MeshPhysicalMaterial({ color: isIce ? 0xcfe6ff : 0x6fa8d8, transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.1, clearcoat: 1, envMapIntensity: 2 }),
        )
        patch.rotation.x = -Math.PI / 2
        patch.position.copy(s.position).addScaledVector(s.up, 0.05)
        patch.rotateZ(-yaw)
        patch.receiveShadow = true
        root.add(patch)
        const jets: THREE.Mesh[] = []
        if (!isIce) {
          const jetMat = new THREE.MeshStandardMaterial({ color: 0xbfe0ff, transparent: true, opacity: 0.6, emissive: 0x4488cc, emissiveIntensity: 0.3 })
          for (let i = 0; i < 6; i++) {
            const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.4, 5, 8, 1, true), jetMat)
            jet.position.copy(s.position).addScaledVector(s.tangent, (i - 2.5) * (span / 6)).addScaledVector(s.up, 2.5)
            root.add(jet)
            jets.push(jet)
          }
        }
        let enabled = true
        this.hazards.push({
          id,
          update: (_dt, time) => {
            const cycle = (time % period) / period
            const shouldEnable = isIce ? cycle < 0.6 : cycle < 0.5
            if (shouldEnable !== enabled) {
              enabled = shouldEnable
              col.setEnabled(enabled)
              ;(patch.material as THREE.MeshPhysicalMaterial).opacity = enabled ? 0.55 : 0.05
              for (const j of jets) j.visible = enabled
            }
            for (const j of jets) j.scale.y = 0.8 + Math.sin(time * 6 + j.position.x) * 0.2
          },
          dispose,
        })
        break
      }
    }
  }

  update(dt: number): void {
    this.time += dt
    for (const h of this.hazards) h.update(dt, this.time)
  }

  dispose(): void {
    for (const h of this.hazards) h.dispose()
    this.hazards = []
  }
}
