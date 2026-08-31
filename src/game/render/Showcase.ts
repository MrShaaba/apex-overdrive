/**
 * Menu / garage showcase: a dark studio with a reflective floor, rim lights
 * and a slowly rotating turntable for the selected car.
 */

import * as THREE from 'three'
import type { TextureFactory } from './TextureFactory'
import { buildCarVisual, type CarVisual } from '../vehicles/CarMeshBuilder'
import type { VehicleCustomization, VehicleSpec } from '../vehicles/VehicleSpec'

export class Showcase {
  readonly root = new THREE.Group()
  private car: CarVisual | null = null
  private carId = ''
  private carHeight = 1.3
  private readonly turntable = new THREE.Group()
  private angle = 0
  autoRotate = true
  private readonly lights: THREE.Light[] = []
  private readonly floor: THREE.Mesh
  private customKey = ''

  constructor(private readonly textures: TextureFactory) {
    this.root.name = 'showcase'
    const floorMat = new THREE.MeshPhysicalMaterial({ color: 0x0b0d12, roughness: 0.18, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 1.5 })
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(40, 64), floorMat)
    this.floor.rotation.x = -Math.PI / 2
    this.floor.receiveShadow = true
    this.root.add(this.floor)
    const podium = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.6, 0.25, 64), new THREE.MeshStandardMaterial({ color: 0x1a1d25, roughness: 0.5, metalness: 0.4 }))
    podium.position.y = 0.12
    podium.receiveShadow = true
    this.root.add(podium)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.05, 8, 96), new THREE.MeshStandardMaterial({ color: 0xff6a00, emissive: 0xff6a00, emissiveIntensity: 3 }))
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.26
    this.root.add(ring)
    const key = new THREE.SpotLight(0xffffff, 2200, 60, 0.5, 0.5, 1.5)
    key.position.set(8, 14, 10)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.bias = -0.0003
    const fill = new THREE.SpotLight(0x7ef0ff, 700, 60, 0.7, 0.6, 1.5)
    fill.position.set(-12, 8, -6)
    const rim = new THREE.SpotLight(0xff6a00, 900, 60, 0.6, 0.6, 1.5)
    rim.position.set(2, 6, -14)
    const ambient = new THREE.HemisphereLight(0x5a6a80, 0x05060a, 1.4)
    for (const l of [key, fill, rim, ambient]) {
      this.root.add(l)
      this.lights.push(l)
    }
    this.root.add(key.target, fill.target, rim.target)
    this.turntable.position.y = 0.25
    this.root.add(this.turntable)
    // Backdrop wall panels.
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x0a0c11, roughness: 0.9 })
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(38, 38, 20, 48, 1, true), wallMat)
    wall.position.y = 10
    wall.material.side = THREE.BackSide
    this.root.add(wall)
    for (let i = 0; i < 10; i++) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.15, 12, 0.15), new THREE.MeshStandardMaterial({ color: 0x223, emissive: i % 2 ? 0x7ef0ff : 0xff6a00, emissiveIntensity: 1.5 }))
      const a = (i / 10) * Math.PI * 2
      strip.position.set(Math.cos(a) * 36, 6, Math.sin(a) * 36)
      this.root.add(strip)
    }
  }

  setCar(spec: VehicleSpec, custom: VehicleCustomization): void {
    const key = JSON.stringify(custom)
    if (this.car && this.carId === spec.id) {
      if (key !== this.customKey) {
        this.car.setCustomization(custom)
        this.customKey = key
      }
      return
    }
    if (this.car) {
      this.turntable.remove(this.car.root)
      this.car.dispose()
    }
    this.car = buildCarVisual(spec, custom, this.textures, true)
    this.carId = spec.id
    this.customKey = key
    this.carHeight = spec.body.height
    // Position the visual so the wheels sit on the podium.
    this.car.root.position.y = spec.comHeight
    this.car.wheels.forEach((w, i) => {
      const x = (i % 2 === 0 ? -1 : 1) * spec.body.trackWidth * 0.5
      const z = (i < 2 ? 1 : -1) * spec.body.wheelbase * 0.5
      w.position.set(x, spec.body.wheelRadius - spec.comHeight, z)
    })
    this.car.setLights(true, false, false)
    this.turntable.add(this.car.root)
  }

  update(dt: number, dragDelta: number): void {
    if (this.autoRotate) this.angle += dt * 0.25
    this.angle += dragDelta
    this.turntable.rotation.y = this.angle
  }

  get cameraTarget(): THREE.Vector3 {
    // Aim at the visual centre of the car on the podium (podium top at 0.25),
    // so low open-wheelers sit centred in frame rather than below it.
    return new THREE.Vector3(0, 0.25 + this.carHeight * 0.5, 0)
  }

  dispose(): void {
    if (this.car) this.car.dispose()
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        ;(o.material as THREE.Material).dispose()
      }
    })
  }
}
