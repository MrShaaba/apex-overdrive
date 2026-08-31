/**
 * Procedural performance-car meshes.
 *
 * Each `BodyShape` is described by silhouette curves (beltline, roof/hood line,
 * plan width, cabin extent). The body is lofted from smoothed cross-sections
 * along the length, giving a continuous, reflective shell that reads as a car
 * under image-based lighting. Detail meshes (lights, splitter, diffuser, wing,
 * mirrors, exhausts, rims, calipers, plate) are added on top and styled by the
 * customization state. Two LOD levels are generated. The body geometry keeps
 * its rest positions so collision damage can dent it at runtime.
 */

import * as THREE from 'three'
import type { TextureFactory } from '../render/TextureFactory'
import type { BodyShape, RimStyle, VehicleCustomization, VehicleSpec, WingStyle } from './VehicleSpec'
import { lerp, smoothstep } from '../core/MathUtils'

export interface CarVisual {
  root: THREE.Group
  lod: THREE.LOD
  body: THREE.Mesh
  bodyLow: THREE.Mesh
  glass: THREE.Mesh
  wheels: THREE.Group[]
  wheelSpin: THREE.Object3D[]
  paint: THREE.MeshPhysicalMaterial
  glassMat: THREE.MeshPhysicalMaterial
  headlights: THREE.Mesh[]
  taillights: THREE.Mesh[]
  headlightSpots: THREE.SpotLight[]
  exhausts: THREE.Vector3[]
  restPositions: Float32Array
  bodyOffsetY: number
  setCustomization(c: VehicleCustomization): void
  setLights(on: boolean, brake: boolean, reverse: boolean): void
  dent(localPoint: THREE.Vector3, localDir: THREE.Vector3, strength: number): void
  setDirt(amount: number): void
  dispose(): void
}

interface ShapeProfile {
  /** Beltline height as fraction of total height, along u (0=rear,1=front). */
  belt(u: number): number
  /** Top surface height fraction along u. */
  top(u: number): number
  /** Plan half-width fraction along u. */
  width(u: number): number
  /** Cabin (glass) range in u. */
  cabin: [number, number]
  /** Roof half-width fraction (relative to body). */
  roofWidth: number
  bottom(u: number): number
}

const bump = (u: number, a: number, b: number, softness = 0.06): number => smoothstep(a - softness, a + softness, u) * (1 - smoothstep(b - softness, b + softness, u))

const PROFILES: Record<BodyShape, ShapeProfile> = {
  roadster: {
    belt: (u) => 0.55 - 0.05 * Math.abs(u - 0.5),
    top: (u) => 0.62 + 0.38 * bump(u, 0.3, 0.55, 0.09) - 0.08 * smoothstep(0.75, 1, u) - 0.05 * (1 - smoothstep(0, 0.2, u)),
    width: (u) => 1 - 0.18 * Math.pow(Math.abs(u - 0.5) * 2, 3) - 0.06 * smoothstep(0.85, 1, u),
    cabin: [0.28, 0.58],
    roofWidth: 0.82,
    bottom: () => 0,
  },
  vintage: {
    belt: (u) => 0.58 + 0.03 * Math.sin(u * Math.PI),
    top: (u) => 0.6 + 0.4 * bump(u, 0.28, 0.6, 0.12) - 0.12 * smoothstep(0.7, 1, u) - 0.05 * (1 - smoothstep(0, 0.22, u)),
    width: (u) => 0.94 - 0.12 * Math.pow(Math.abs(u - 0.5) * 2, 2),
    cabin: [0.3, 0.6],
    roofWidth: 0.78,
    bottom: () => 0,
  },
  hatch: {
    belt: () => 0.5,
    top: (u) => 0.62 + 0.38 * bump(u, 0.05, 0.62, 0.1) - 0.1 * smoothstep(0.78, 1, u),
    width: (u) => 1 - 0.08 * Math.pow(Math.abs(u - 0.5) * 2, 3),
    cabin: [0.08, 0.66],
    roofWidth: 0.86,
    bottom: () => 0,
  },
  drift: {
    belt: (u) => 0.54 - 0.04 * u,
    top: (u) => 0.6 + 0.4 * bump(u, 0.22, 0.58, 0.1) - 0.1 * smoothstep(0.75, 1, u) - 0.05 * (1 - smoothstep(0, 0.15, u)),
    width: (u) => 1 - 0.14 * Math.pow(Math.abs(u - 0.5) * 2, 3) - 0.05 * smoothstep(0.88, 1, u),
    cabin: [0.24, 0.6],
    roofWidth: 0.84,
    bottom: () => 0,
  },
  gt: {
    belt: (u) => 0.52 - 0.03 * u,
    top: (u) => 0.58 + 0.42 * bump(u, 0.22, 0.6, 0.12) - 0.12 * smoothstep(0.7, 1, u) - 0.04 * (1 - smoothstep(0, 0.18, u)),
    width: (u) => 1 - 0.12 * Math.pow(Math.abs(u - 0.5) * 2, 3) - 0.06 * smoothstep(0.86, 1, u),
    cabin: [0.24, 0.62],
    roofWidth: 0.84,
    bottom: () => 0,
  },
  ev: {
    belt: () => 0.5,
    top: (u) => 0.6 + 0.4 * bump(u, 0.15, 0.65, 0.14) - 0.12 * smoothstep(0.72, 1, u) - 0.05 * (1 - smoothstep(0, 0.14, u)),
    width: (u) => 1 - 0.1 * Math.pow(Math.abs(u - 0.5) * 2, 3) - 0.08 * smoothstep(0.85, 1, u),
    cabin: [0.18, 0.66],
    roofWidth: 0.86,
    bottom: () => 0,
  },
  supercar: {
    belt: (u) => 0.5 - 0.06 * u,
    top: (u) => 0.5 + 0.5 * bump(u, 0.3, 0.62, 0.1) - 0.18 * smoothstep(0.72, 1, u) - 0.02 * (1 - smoothstep(0, 0.2, u)),
    width: (u) => 1 - 0.1 * Math.pow(Math.abs(u - 0.5) * 2, 3) - 0.1 * smoothstep(0.82, 1, u),
    cabin: [0.32, 0.64],
    roofWidth: 0.78,
    bottom: () => 0,
  },
  track: {
    belt: (u) => 0.5 - 0.06 * u,
    top: (u) => 0.5 + 0.5 * bump(u, 0.3, 0.6, 0.1) - 0.16 * smoothstep(0.72, 1, u),
    width: (u) => 1 - 0.1 * Math.pow(Math.abs(u - 0.5) * 2, 3) - 0.08 * smoothstep(0.86, 1, u),
    cabin: [0.32, 0.62],
    roofWidth: 0.76,
    bottom: () => 0,
  },
  prototype: {
    belt: (u) => 0.42 - 0.05 * u,
    top: (u) => 0.38 + 0.62 * bump(u, 0.36, 0.6, 0.09) - 0.14 * smoothstep(0.7, 1, u) + 0.12 * (1 - smoothstep(0, 0.12, u)),
    width: (u) => 1 - 0.06 * Math.pow(Math.abs(u - 0.5) * 2, 4) - 0.2 * smoothstep(0.8, 1, u) * (u > 0.9 ? 1 : 0.5),
    cabin: [0.38, 0.6],
    roofWidth: 0.5,
    bottom: () => 0,
  },
}

/** Build a smoothed closed cross-section (full ring) for the body at station u. */
function crossSection(profile: ShapeProfile, u: number, hw: number, height: number, clearance: number, ringPoints: number, cabinBlend: number): THREE.Vector2[] {
  const halfW = hw * profile.width(u)
  const beltY = clearance + (height - clearance) * profile.belt(u)
  const topY = clearance + (height - clearance) * profile.top(u)
  const roofHw = halfW * lerp(0.95, profile.roofWidth, cabinBlend)
  const bottomY = clearance * 0.9
  // Right half control points from bottom centre to top centre.
  const ctrl: THREE.Vector2[] = [
    new THREE.Vector2(0, bottomY),
    new THREE.Vector2(halfW * 0.8, bottomY),
    new THREE.Vector2(halfW * 0.98, bottomY + 0.06),
    new THREE.Vector2(halfW, beltY * 0.75),
    new THREE.Vector2(halfW * 0.985, beltY),
    new THREE.Vector2(roofHw, topY - (topY - beltY) * 0.25),
    new THREE.Vector2(roofHw * 0.8, topY),
    new THREE.Vector2(0, topY + 0.005),
  ]
  const curve = new THREE.SplineCurve(ctrl)
  const half = curve.getPoints(ringPoints / 2)
  const ring: THREE.Vector2[] = []
  // Top centre → down the left flank → bottom centre → up the right flank.
  // Both centreline points are emitted once so the ring has exactly ringPoints
  // vertices — the loft indexes with stride ringPoints and wraps via modulo.
  for (let i = half.length - 1; i >= 0; i--) ring.push(new THREE.Vector2(-half[i].x, half[i].y))
  for (let i = 1; i < half.length - 1; i++) ring.push(half[i].clone())
  return ring
}

function loftBody(spec: VehicleSpec, stations: number, ringPoints: number): { geometry: THREE.BufferGeometry; glassMask: Uint8Array } {
  const profile = PROFILES[spec.body.shape]
  const b = spec.body
  const half = b.length / 2
  const positions: number[] = []
  const uvs: number[] = []
  const rings: THREE.Vector2[][] = []
  const glassFlags: boolean[][] = []
  for (let s = 0; s < stations; s++) {
    const u = s / (stations - 1)
    const cabinBlend = bump(u, profile.cabin[0], profile.cabin[1], 0.05)
    const ring = crossSection(profile, u, b.width / 2, b.height, b.groundClearance, ringPoints, cabinBlend)
    rings.push(ring)
    const z = lerp(-half, half, u)
    // Taper nose and tail to a closed-ish end.
    const endScale = s === 0 || s === stations - 1 ? 0.55 : 1
    const beltY = b.groundClearance + (b.height - b.groundClearance) * profile.belt(u)
    const flags: boolean[] = []
    ring.forEach((p, i) => {
      positions.push(p.x * endScale, p.y, z)
      uvs.push(u, i / ring.length)
      flags.push(p.y > beltY + 0.02 && cabinBlend > 0.5)
    })
    glassFlags.push(flags)
  }
  const n = ringPoints
  const bodyIdx: number[] = []
  const glassIdx: number[] = []
  const glassMask = new Uint8Array(stations * n)
  for (let s = 0; s < stations - 1; s++) {
    for (let i = 0; i < n; i++) {
      const a = s * n + i
      const bIdx = s * n + ((i + 1) % n)
      const c = (s + 1) * n + i
      const d = (s + 1) * n + ((i + 1) % n)
      const isGlass = glassFlags[s][i] && glassFlags[s + 1][i] && glassFlags[s][(i + 1) % n]
      const target = isGlass ? glassIdx : bodyIdx
      target.push(a, bIdx, c, bIdx, d, c)
      if (isGlass) glassMask[a] = glassMask[bIdx] = glassMask[c] = glassMask[d] = 1
    }
  }
  // Cap ends.
  const capCenter = (s: number, front: boolean) => {
    const baseIndex = positions.length / 3
    const z = front ? half : -half
    const u = front ? 1 : 0
    const cy = b.groundClearance + (b.height - b.groundClearance) * (profile.belt(u) * 0.6 + profile.top(u) * 0.2)
    positions.push(0, cy, z)
    uvs.push(u, 0.5)
    for (let i = 0; i < n; i++) {
      const a = s * n + i
      const bIdx = s * n + ((i + 1) % n)
      if (front) bodyIdx.push(a, bIdx, baseIndex)
      else bodyIdx.push(bIdx, a, baseIndex)
    }
  }
  capCenter(0, false)
  capCenter(stations - 1, true)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex([...bodyIdx, ...glassIdx])
  geometry.addGroup(0, bodyIdx.length, 0)
  geometry.addGroup(bodyIdx.length, glassIdx.length, 1)
  geometry.computeVertexNormals()
  return { geometry, glassMask }
}

function finishParams(finish: VehicleCustomization['finish']): Partial<THREE.MeshPhysicalMaterialParameters> {
  switch (finish) {
    case 'gloss':
      return { metalness: 0.15, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.06, iridescence: 0 }
    case 'metallic':
      return { metalness: 0.75, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.1, iridescence: 0 }
    case 'matte':
      return { metalness: 0.05, roughness: 0.78, clearcoat: 0, clearcoatRoughness: 0.5, iridescence: 0 }
    case 'pearl':
      return { metalness: 0.4, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0.9, iridescenceIOR: 1.6 }
    case 'chrome':
      return { metalness: 1, roughness: 0.05, clearcoat: 0.6, clearcoatRoughness: 0.03, iridescence: 0 }
    case 'satin':
      return { metalness: 0.5, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.3, iridescence: 0 }
  }
}

function buildRim(style: RimStyle, radius: number, width: number, color: string): THREE.Group {
  const g = new THREE.Group()
  const metal = new THREE.MeshStandardMaterial({ color, metalness: 0.9, roughness: 0.25 })
  const rimR = radius * 0.62
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rimR, rimR, width * 0.9, 24, 1, true), metal)
  barrel.rotation.z = Math.PI / 2
  g.add(barrel)
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.28, rimR * 0.28, width * 0.95, 12), metal)
  hub.rotation.z = Math.PI / 2
  g.add(hub)
  const spokes = style === 'sport5' ? 5 : style === 'mesh' ? 12 : style === 'turbine' ? 9 : style === 'deepdish' ? 6 : style === 'classic' ? 8 : style === 'aero' ? 3 : 10
  const spokeW = style === 'mesh' || style === 'split10' ? rimR * 0.1 : style === 'aero' ? rimR * 0.5 : rimR * 0.2
  const spokeGeo = new THREE.BoxGeometry(width * 0.5, rimR * 0.95, spokeW)
  for (let i = 0; i < spokes; i++) {
    const s = new THREE.Mesh(spokeGeo, metal)
    const a = (i / spokes) * Math.PI * 2
    s.position.set(width * (style === 'deepdish' ? -0.15 : 0.2), Math.sin(a) * rimR * 0.5, Math.cos(a) * rimR * 0.5)
    s.rotation.x = -a + (style === 'turbine' ? 0.35 : 0)
    g.add(s)
  }
  return g
}

export function buildCarVisual(spec: VehicleSpec, custom: VehicleCustomization, textures: TextureFactory, highDetail = true): CarVisual {
  const root = new THREE.Group()
  root.name = `car-${spec.id}`
  const b = spec.body
  const bodyOffsetY = -spec.comHeight

  // --- Materials ---
  const paint = new THREE.MeshPhysicalMaterial({ color: custom.paint, ...finishParams(custom.finish), envMapIntensity: 1.2 })
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x0a0d14, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.55 + custom.windowTint * 0.4, envMapIntensity: 1.5, clearcoat: 1 })
  const trim = new THREE.MeshStandardMaterial({ color: 0x0c0d10, metalness: 0.3, roughness: 0.55 })
  const carbon = new THREE.MeshStandardMaterial({ color: 0x1b1d22, metalness: 0.45, roughness: 0.35 })
  const chrome = new THREE.MeshStandardMaterial({ color: 0xdfe3ea, metalness: 1, roughness: 0.12 })
  const lampOn = new THREE.MeshStandardMaterial({ color: 0xfff6d5, emissive: 0xfff2c0, emissiveIntensity: 2.5, roughness: 0.3 })
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x5a0a12, emissive: 0xff1a2a, emissiveIntensity: 0.6, roughness: 0.3 })
  const rubber = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92, metalness: 0 })
  const disc = new THREE.MeshStandardMaterial({ color: 0x777b82, metalness: 0.85, roughness: 0.5 })
  const caliper = new THREE.MeshStandardMaterial({ color: custom.accent, metalness: 0.4, roughness: 0.4 })

  // --- Body lofts (hi / lo) ---
  const hi = loftBody(spec, highDetail ? 44 : 26, highDetail ? 36 : 20)
  const lo = loftBody(spec, 12, 12)
  const body = new THREE.Mesh(hi.geometry, [paint, glassMat])
  body.castShadow = true
  body.receiveShadow = true
  body.position.y = bodyOffsetY
  const bodyLow = new THREE.Mesh(lo.geometry, [paint, glassMat])
  bodyLow.position.y = bodyOffsetY
  bodyLow.castShadow = true

  const detail = new THREE.Group()
  detail.position.y = bodyOffsetY
  const half = b.length / 2
  const hw = b.width / 2
  const topH = b.height

  // Splitter / front bumper.
  const bumperDepth = custom.bumper === 'race' ? 0.22 : custom.bumper === 'widebody' ? 0.18 : custom.bumper === 'street' ? 0.12 : 0.06
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(b.width * 0.96, 0.04, 0.3 + bumperDepth), carbon)
  splitter.position.set(0, b.groundClearance + 0.02, half - 0.05 + bumperDepth * 0.5)
  detail.add(splitter)
  // Rear diffuser.
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(b.width * 0.8, 0.12, 0.35), carbon)
  diffuser.position.set(0, b.groundClearance + 0.06, -half + 0.12)
  diffuser.rotation.x = -0.35
  detail.add(diffuser)
  // Side skirts for race/widebody.
  if (custom.bumper !== 'stock') {
    for (const s of [-1, 1]) {
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(custom.bumper === 'widebody' ? 0.16 : 0.08, 0.08, b.length * 0.55), carbon)
      skirt.position.set(s * (hw - 0.02 + (custom.bumper === 'widebody' ? 0.06 : 0)), b.groundClearance + 0.04, 0)
      detail.add(skirt)
    }
  }
  // Grille.
  const grille = new THREE.Mesh(new THREE.BoxGeometry(b.width * 0.42, (topH - b.groundClearance) * 0.16, 0.06), trim)
  const noseTopY = b.groundClearance + (topH - b.groundClearance) * PROFILES[b.shape].belt(1)
  grille.position.set(0, noseTopY * 0.62, half - 0.02)
  detail.add(grille)

  // Headlights.
  const headlights: THREE.Mesh[] = []
  const lampGeo = new THREE.BoxGeometry(b.width * 0.16, (topH - b.groundClearance) * 0.09, 0.08)
  for (const s of [-1, 1]) {
    const lamp = new THREE.Mesh(lampGeo, lampOn.clone())
    lamp.position.set(s * hw * 0.62, noseTopY * 0.95, half - 0.1)
    lamp.rotation.y = -s * 0.5
    detail.add(lamp)
    headlights.push(lamp)
  }
  const headlightSpots: THREE.SpotLight[] = []
  if (highDetail) {
    for (const s of [-1, 1]) {
      const spot = new THREE.SpotLight(0xfff1d0, 0, 60, 0.55, 0.6, 1.2)
      // Parented to the root (not the LOD detail group) so the beams keep
      // working when the shell is hidden in cockpit view.
      spot.position.set(s * hw * 0.6, noseTopY + bodyOffsetY, half - 0.1)
      spot.target.position.set(s * hw * 0.6, -1.5 + bodyOffsetY, half + 25)
      spot.castShadow = false
      root.add(spot, spot.target)
      headlightSpots.push(spot)
    }
  }
  // Taillights.
  const taillights: THREE.Mesh[] = []
  const tailTopY = b.groundClearance + (topH - b.groundClearance) * PROFILES[b.shape].belt(0)
  const tailGeo = new THREE.BoxGeometry(b.width * 0.3, (topH - b.groundClearance) * 0.07, 0.06)
  for (const s of [-1, 1]) {
    const t = new THREE.Mesh(tailGeo, tailMat.clone())
    t.position.set(s * hw * 0.5, tailTopY * 0.98, -half + 0.08)
    detail.add(t)
    taillights.push(t)
  }
  // Mirrors.
  const cabin = PROFILES[b.shape].cabin
  const beltY = b.groundClearance + (topH - b.groundClearance) * PROFILES[b.shape].belt(cabin[1])
  for (const s of [-1, 1]) {
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.16), paint)
    mirror.position.set(s * (hw + 0.07), beltY + 0.05, lerp(-half, half, cabin[1] - 0.02))
    detail.add(mirror)
  }
  // Exhausts.
  const exhausts: THREE.Vector3[] = []
  if (spec.engine.type !== 'ev') {
    const n = spec.engine.cylinders >= 8 ? 4 : 2
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * 0.18 + (n === 2 ? 0 : 0) 
      const side = n === 2 ? (i === 0 ? -1 : 1) * hw * 0.55 : x + (i < n / 2 ? -hw * 0.5 : hw * 0.5)
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.16, 12, 1, true), chrome)
      tip.rotation.x = Math.PI / 2
      tip.position.set(side, b.groundClearance + 0.12, -half - 0.02)
      detail.add(tip)
      exhausts.push(new THREE.Vector3(side, b.groundClearance + 0.12 + bodyOffsetY, -half - 0.1))
    }
  }
  // Plate.
  const plateMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.12), new THREE.MeshStandardMaterial({ map: textures.plate(custom.plate), roughness: 0.6 }))
  plateMesh.position.set(0, b.groundClearance + 0.28, -half - 0.005)
  plateMesh.rotation.y = Math.PI
  detail.add(plateMesh)

  // Wing.
  let wingGroup: THREE.Group | null = null
  const buildWing = (style: WingStyle): THREE.Group | null => {
    if (style === 'none') return null
    const g = new THREE.Group()
    const roofY = b.groundClearance + (topH - b.groundClearance) * PROFILES[b.shape].top(0.05)
    if (style === 'lip') {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(b.width * 0.8, 0.03, 0.14), carbon)
      lip.position.set(0, roofY + 0.02, -half + 0.12)
      g.add(lip)
    } else if (style === 'ducktail') {
      const d = new THREE.Mesh(new THREE.BoxGeometry(b.width * 0.85, 0.04, 0.22), paint)
      d.position.set(0, roofY + 0.06, -half + 0.16)
      d.rotation.x = 0.35
      g.add(d)
    } else {
      const h = style === 'dtm' ? 0.42 : style === 'swan' ? 0.36 : 0.3
      const plane = new THREE.Mesh(new THREE.BoxGeometry(b.width * (style === 'dtm' ? 1.0 : 0.9), 0.025, style === 'dtm' ? 0.34 : 0.26), carbon)
      plane.position.set(0, roofY + h, -half + 0.2)
      plane.rotation.x = 0.18
      g.add(plane)
      const uprightGeo = new THREE.BoxGeometry(0.04, h, style === 'swan' ? 0.3 : 0.14)
      for (const s of [-1, 1]) {
        const up = new THREE.Mesh(uprightGeo, carbon)
        up.position.set(s * hw * (style === 'swan' ? 0.25 : 0.7), roofY + h / 2, -half + 0.22)
        g.add(up)
      }
      if (style === 'dtm' || style === 'gt') {
        for (const s of [-1, 1]) {
          const endplate = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.16, 0.34), carbon)
          endplate.position.set(s * hw * 0.98, roofY + h, -half + 0.2)
          g.add(endplate)
        }
      }
    }
    return g
  }
  wingGroup = buildWing(custom.wing)
  if (wingGroup) detail.add(wingGroup)
  if (b.shape === 'prototype') {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.35, b.length * 0.32), paint)
    fin.position.set(0, topH * 0.95, -half * 0.45)
    detail.add(fin)
  }
  if (b.shape === 'track' || b.shape === 'supercar') {
    const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.3), trim)
    scoop.position.set(0, topH * 0.9, -half * 0.25)
    detail.add(scoop)
  }

  // --- Wheels ---
  const wheels: THREE.Group[] = []
  const wheelSpin: THREE.Object3D[] = []
  const tireGeo = new THREE.CylinderGeometry(b.wheelRadius, b.wheelRadius, b.wheelWidth, highDetail ? 28 : 14, 1, false)
  const discGeo = new THREE.CylinderGeometry(b.wheelRadius * 0.58, b.wheelRadius * 0.58, 0.03, 20)
  for (let i = 0; i < 4; i++) {
    const hub = new THREE.Group()
    const spin = new THREE.Group()
    const tire = new THREE.Mesh(tireGeo, rubber)
    tire.rotation.z = Math.PI / 2
    tire.castShadow = true
    spin.add(tire)
    const rim = buildRim(custom.rims, b.wheelRadius, b.wheelWidth, custom.rimColor)
    spin.add(rim)
    // Tyre lettering band.
    if (custom.tires === 'drift' || custom.tires === 'slick' || custom.tires === 'semi-slick') {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(b.wheelRadius * 0.99, b.wheelRadius * 0.99, b.wheelWidth * 0.2, 24, 1, true), new THREE.MeshStandardMaterial({ color: custom.tires === 'slick' ? 0xff3030 : 0xf0f0f0, roughness: 0.8 }))
      band.rotation.z = Math.PI / 2
      band.position.x = (i % 2 === 0 ? -1 : 1) * b.wheelWidth * 0.35
      spin.add(band)
    }
    if (custom.tires === 'rally' || custom.tires === 'winter') {
      const knobs = new THREE.Mesh(new THREE.CylinderGeometry(b.wheelRadius * 1.02, b.wheelRadius * 1.02, b.wheelWidth * 0.9, 12, 1, true), rubber)
      knobs.rotation.z = Math.PI / 2
      spin.add(knobs)
    }
    hub.add(spin)
    const brakeDisc = new THREE.Mesh(discGeo, disc)
    brakeDisc.rotation.z = Math.PI / 2
    hub.add(brakeDisc)
    const cal = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.1), caliper)
    cal.position.set((i % 2 === 0 ? 1 : -1) * 0.02, 0.02, b.wheelRadius * 0.45)
    hub.add(cal)
    root.add(hub)
    wheels.push(hub)
    wheelSpin.push(spin)
  }

  const lod = new THREE.LOD()
  const hiGroup = new THREE.Group()
  hiGroup.add(body, detail)
  lod.addLevel(hiGroup, 0)
  lod.addLevel(bodyLow, 120)
  root.add(lod)

  const restPositions = new Float32Array(hi.geometry.attributes.position.array as Float32Array)
  const displaced = new Float32Array(restPositions.length)
  const glass = body

  const visual: CarVisual = {
    root,
    lod,
    body,
    bodyLow,
    glass,
    wheels,
    wheelSpin,
    paint,
    glassMat,
    headlights,
    taillights,
    headlightSpots,
    exhausts,
    restPositions,
    bodyOffsetY,
    setCustomization(c) {
      paint.color.set(c.paint)
      Object.assign(paint, finishParams(c.finish))
      if (c.livery !== 'none') {
        paint.map = textures.livery(c)
        paint.color.set('#ffffff')
      } else paint.map = null
      paint.needsUpdate = true
      glassMat.opacity = 0.55 + c.windowTint * 0.4
      caliper.color.set(c.accent)
      ;(plateMesh.material as THREE.MeshStandardMaterial).map = textures.plate(c.plate)
      ;(plateMesh.material as THREE.MeshStandardMaterial).needsUpdate = true
      if (wingGroup) {
        detail.remove(wingGroup)
        wingGroup = null
      }
      wingGroup = buildWing(c.wing)
      if (wingGroup) detail.add(wingGroup)
      // Rims: rebuild.
      wheels.forEach((hub, i) => {
        const spin = wheelSpin[i]
        const old = spin.children.find((ch) => ch instanceof THREE.Group)
        if (old) spin.remove(old)
        spin.add(buildRim(c.rims, b.wheelRadius, b.wheelWidth, c.rimColor))
        void hub
      })
    },
    setLights(on, brake, reverse) {
      for (const h of headlights) (h.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 1.4 : 0.15
      for (const s of headlightSpots) s.intensity = on ? 120 : 0
      for (const t of taillights) (t.material as THREE.MeshStandardMaterial).emissiveIntensity = brake ? 2.2 : on ? 0.9 : 0.3
      void reverse
    },
    dent(localPoint, localDir, strength) {
      const pos = hi.geometry.attributes.position as THREE.BufferAttribute
      const arr = pos.array as Float32Array
      const radius = 0.7
      const r2 = radius * radius
      for (let i = 0; i < arr.length; i += 3) {
        const dx = restPositions[i] - localPoint.x
        const dy = restPositions[i + 1] - localPoint.y
        const dz = restPositions[i + 2] - localPoint.z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > r2) continue
        const falloff = 1 - d2 / r2
        const amount = strength * falloff * falloff
        displaced[i] += localDir.x * amount
        displaced[i + 1] += localDir.y * amount
        displaced[i + 2] += localDir.z * amount
        const mag = Math.hypot(displaced[i], displaced[i + 1], displaced[i + 2])
        if (mag > 0.22) {
          const k = 0.22 / mag
          displaced[i] *= k
          displaced[i + 1] *= k
          displaced[i + 2] *= k
        }
        arr[i] = restPositions[i] + displaced[i]
        arr[i + 1] = restPositions[i + 1] + displaced[i + 1]
        arr[i + 2] = restPositions[i + 2] + displaced[i + 2]
      }
      pos.needsUpdate = true
      hi.geometry.computeVertexNormals()
    },
    setDirt(amount) {
      const k = 1 - amount * 0.35
      paint.color.setRGB(paint.color.r * k + (1 - k) * 0.35, paint.color.g * k + (1 - k) * 0.3, paint.color.b * k + (1 - k) * 0.25)
      paint.roughness = Math.min(0.95, paint.roughness + amount * 0.4)
    },
    dispose() {
      hi.geometry.dispose()
      lo.geometry.dispose()
      tireGeo.dispose()
      discGeo.dispose()
      for (const m of [paint, glassMat, trim, carbon, chrome, lampOn, tailMat, rubber, disc, caliper]) m.dispose()
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
        }
      })
    },
  }
  visual.setCustomization(custom)
  return visual
}
