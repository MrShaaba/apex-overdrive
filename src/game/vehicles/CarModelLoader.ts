/**
 * Licensed glTF car models.
 *
 * `modelLibrary` loads and caches the compressed .glb files produced by
 * tools/asset-pipeline/prepare-car.mjs (Draco geometry, KTX2 textures) once
 * per session; `buildModelCarVisual()` then clones the cached template into a
 * `CarVisual` that behaves exactly like the procedural one: the body sits in
 * `lod`, the four `wheel_N` hubs hang off the root and are positioned every
 * frame from the physics wheels, `wheel_N_spin` children spin about the axle.
 *
 * Node contract baked by the pipeline (all in metres, +Z forward, ground at
 * y = 0, x/z = 0 at the wheelbase midpoint):
 *   body                      – everything that is not a wheel
 *   body/cockpit_hidden       – the model's own steering wheel (hidden in cockpit view)
 *   body/light_brake          – meshes that glow with the brake light
 *   wheel_0..3                – FL, FR, RL, RR steer groups, origin at the wheel centre
 *   wheel_N/wheel_N_spin      – tyre + rim, spin about local X
 *
 * Loading is asynchronous, so callers preload (`modelLibrary.preload`) during
 * a loading screen and fall back to the procedural mesh when `get()` returns
 * null — the game never depends on the file being present.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import type { CarVisual } from './CarMeshBuilder'
import type { VehicleSpec } from './VehicleSpec'

const BASE = import.meta.env.BASE_URL

class ModelLibrary {
  private loader: GLTFLoader | null = null
  private ktx2: KTX2Loader | null = null
  private draco: DRACOLoader | null = null
  private readonly cache = new Map<string, THREE.Group>()
  private readonly pending = new Map<string, Promise<boolean>>()
  private readonly failed = new Set<string>()

  /** Must run once the renderer exists (KTX2 transcoding targets depend on it). */
  init(renderer: THREE.WebGLRenderer): void {
    if (this.loader) return
    this.draco = new DRACOLoader().setDecoderPath(`${BASE}libs/draco/`)
    this.ktx2 = new KTX2Loader().setTranscoderPath(`${BASE}libs/basis/`).detectSupport(renderer)
    this.loader = new GLTFLoader().setDRACOLoader(this.draco).setKTX2Loader(this.ktx2)
  }

  /** Cached template scene for a model file, or null when not (yet) loaded. */
  get(file: string): THREE.Group | null {
    return this.cache.get(file) ?? null
  }

  /** Resolves true when the model is ready, false if it is missing or broken (logged once). */
  preload(file: string, onProgress?: (fraction: number) => void): Promise<boolean> {
    if (this.cache.has(file)) return Promise.resolve(true)
    if (this.failed.has(file)) return Promise.resolve(false)
    const inflight = this.pending.get(file)
    if (inflight) return inflight
    if (!this.loader) {
      console.warn('[Models] preload before init — using procedural mesh for', file)
      return Promise.resolve(false)
    }
    const p = this.loader
      .loadAsync(`${BASE}${file}`, (event) => {
        if (event.total > 0) onProgress?.(Math.min(1, event.loaded / event.total))
      })
      .then((gltf) => {
        const scene = gltf.scene
        scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true
            o.receiveShadow = false
            // Draw-order safety for the few transparent parts (visors, lenses).
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            for (const m of mats) if (m.transparent) m.depthWrite = false
          }
        })
        this.cache.set(file, scene)
        return true
      })
      .catch((err: unknown) => {
        this.failed.add(file)
        console.warn(`[Models] ${file} unavailable — procedural mesh in use`, err)
        return false
      })
      .finally(() => this.pending.delete(file))
    this.pending.set(file, p)
    return p
  }

  /** Release a circuit once all its instances have been disposed. Car templates stay cached. */
  release(file: string): void {
    const scene = this.cache.get(file)
    if (!scene) return
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      geometries.add(object.geometry)
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material)
    })
    for (const geometry of geometries) geometry.dispose()
    for (const material of materials) disposeMaterial(material)
    this.cache.delete(file)
  }

  dispose(): void {
    for (const scene of this.cache.values()) {
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          for (const m of mats) disposeMaterial(m)
        }
      })
    }
    this.cache.clear()
    this.ktx2?.dispose()
    this.draco?.dispose()
  }
}

export const modelLibrary = new ModelLibrary()

function disposeMaterial(m: THREE.Material): void {
  const rec = m as unknown as Record<string, unknown>
  for (const key of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap']) {
    const t = rec[key]
    if (t instanceof THREE.Texture) t.dispose()
  }
  m.dispose()
}

/**
 * Build a CarVisual from a cached model template. Materials are cloned per
 * instance (textures stay shared) so ghosts and showcase copies can be tinted
 * or faded without touching the player's car; geometry is shared with the
 * template and owned by the library.
 */
export function buildModelCarVisual(spec: VehicleSpec, template: THREE.Group, highDetail: boolean): CarVisual {
  const ref = spec.model!
  const root = new THREE.Group()
  root.name = `car-${spec.id}`
  const b = spec.body
  const bodyOffsetY = -spec.comHeight
  const model = template.clone(true)

  // Per-instance materials, shared within the instance.
  const matClones = new Map<THREE.Material, THREE.Material>()
  const cloneMat = (m: THREE.Material): THREE.Material => {
    let c = matClones.get(m)
    if (!c) {
      c = m.clone()
      matClones.set(m, c)
    }
    return c
  }
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) o.material = Array.isArray(o.material) ? o.material.map(cloneMat) : cloneMat(o.material)
  })

  const find = (name: string): THREE.Object3D | null => model.getObjectByName(name) ?? null
  const bodyNode = find('body') ?? model
  // Body children are looked up on the body itself: it leaves `model` below.
  const findInBody = (name: string): THREE.Object3D | null => bodyNode.getObjectByName(name) ?? null
  const wheels: THREE.Group[] = []
  const wheelSpin: THREE.Object3D[] = []
  for (let i = 0; i < 4; i++) {
    // GLTFLoader turns a node into an Object3D, Mesh or Group depending on
    // its primitives, so wrap whatever came back in a fresh hub group.
    const node = find(`wheel_${i}`)
    const spin = find(`wheel_${i}_spin`)
    if (!node || !spin) throw new Error(`${ref.file}: missing wheel_${i} rig`)
    node.removeFromParent()
    // The pipeline stores the model's wheel centre as the node translation;
    // physics places the hub at ±trackWidth/2, so keep only the difference
    // (a few cm for a normal car, the whole half-track for a two-wheeler's
    // single centred wheel).
    const hubX = (i % 2 === 0 ? -1 : 1) * b.trackWidth * 0.5
    node.position.set(node.position.x - hubX, 0, 0)
    const hub = new THREE.Group()
    hub.name = `hub_${i}`
    hub.add(node)
    hub.position.set((i % 2 === 0 ? -1 : 1) * b.trackWidth * 0.5, b.wheelRadius + bodyOffsetY, (i < 2 ? 1 : -1) * b.wheelbase * 0.5)
    root.add(hub)
    wheels.push(hub)
    wheelSpin.push(spin)
  }

  // Body: single LOD level (only the player drives a licensed model, so no
  // distant impostor is needed), offset so the model's ground sits at the
  // physics ground.
  const bodyGroup = new THREE.Group()
  bodyNode.removeFromParent()
  bodyGroup.add(bodyNode)
  bodyGroup.position.y = bodyOffsetY
  const lod = new THREE.LOD()
  lod.addLevel(bodyGroup, 0)
  root.add(lod)

  // Brake lights: emissive copies driven by setLights.
  const taillights: THREE.Mesh[] = []
  const brakeGroup = findInBody('light_brake')
  brakeGroup?.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const src = (Array.isArray(o.material) ? o.material[0] : o.material) as THREE.MeshStandardMaterial
    const lamp = new THREE.MeshStandardMaterial({ color: 0x3a0308, emissive: 0xff1a2a, emissiveIntensity: 0.3, roughness: 0.3, metalness: 0.1, transparent: false })
    void src
    o.material = lamp
    taillights.push(o)
  })

  // Headlight beams for night races (the model has no lamps; keep the game's
  // beams so the road ahead is lit). Root-parented like the procedural car.
  const headlightSpots: THREE.SpotLight[] = []
  if (highDetail) {
    const half = b.length / 2
    for (const s of [-1, 1]) {
      const spot = new THREE.SpotLight(0xfff1d0, 0, 60, 0.55, 0.6, 1.2)
      spot.position.set(s * b.width * 0.3, 0.35 + bodyOffsetY, half - 0.3)
      spot.target.position.set(s * b.width * 0.3, -1.5 + bodyOffsetY, half + 25)
      spot.castShadow = false
      root.add(spot, spot.target)
      headlightSpots.push(spot)
    }
  }

  const exhausts = ref.exhausts.map(([x, y, z]) => new THREE.Vector3(x, y + bodyOffsetY, z))
  const cockpitHidden: THREE.Object3D[] = []
  const wheelNode = findInBody('cockpit_hidden')
  if (wheelNode) cockpitHidden.push(wheelNode)

  // The interface promises paint/glass handles; give it inert ones so callers
  // that tweak them (dirt, ghost tint) do not touch the licensed textures.
  const paint = new THREE.MeshPhysicalMaterial()
  const glassMat = new THREE.MeshPhysicalMaterial()
  const placeholder = new THREE.Mesh(new THREE.BufferGeometry(), paint)

  const visual: CarVisual = {
    root,
    lod,
    body: placeholder,
    bodyLow: placeholder,
    glass: placeholder,
    wheels,
    wheelSpin,
    paint,
    glassMat,
    headlights: [],
    taillights,
    headlightSpots,
    exhausts,
    restPositions: new Float32Array(0),
    bodyOffsetY,
    cockpitHidden,
    setCustomization() {
      // Licensed livery: paint, decals and rims are baked into the model.
    },
    setLights(on, brake) {
      for (const s of headlightSpots) s.intensity = on ? 120 : 0
      for (const t of taillights) (t.material as THREE.MeshStandardMaterial).emissiveIntensity = brake ? 2.4 : on ? 0.9 : 0.3
    },
    dent() {
      // Rigid licensed mesh: damage stays in the physics/handling model.
    },
    setDirt() {},
    dispose() {
      for (const m of matClones.values()) m.dispose()
      for (const t of taillights) (t.material as THREE.Material).dispose()
      placeholder.geometry.dispose()
      paint.dispose()
      glassMat.dispose()
    },
  }
  return visual
}
