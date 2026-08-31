/**
 * CPU-simulated, GPU-drawn particle systems.
 *
 * `ParticleSystem` owns one `THREE.Points` per sprite kind with per-particle
 * position / size / colour / alpha / rotation attributes and a soft-additive or
 * alpha-blended shader. Emitters push particles into a fixed-size ring buffer,
 * so the memory footprint is constant and bounded by the quality budget.
 *
 * `PrecipitationSystem` renders rain streaks / snow flakes in a box that
 * follows the camera and wraps around, so weather never "runs out".
 */

import * as THREE from 'three'
import type { TextureFactory } from './TextureFactory'

export type ParticleKind = 'smoke' | 'dust' | 'gravel' | 'grass' | 'snowdust' | 'spark' | 'exhaust' | 'spray' | 'splash' | 'debris'

interface ParticleGroupConfig {
  sprite: 'smoke' | 'spark' | 'flare' | 'splash' | 'leaf'
  additive: boolean
  gravity: number
  drag: number
  growth: number
  color: THREE.Color
  colorEnd: THREE.Color
  baseSize: number
  life: number
  alpha: number
  budgetShare: number
}

const CONFIG: Record<ParticleKind, ParticleGroupConfig> = {
  smoke: { sprite: 'smoke', additive: false, gravity: 0.4, drag: 1.6, growth: 2.4, color: new THREE.Color(0.85, 0.85, 0.86), colorEnd: new THREE.Color(0.6, 0.6, 0.62), baseSize: 0.9, life: 1.8, alpha: 0.22, budgetShare: 0.28 },
  dust: { sprite: 'smoke', additive: false, gravity: -0.5, drag: 1.4, growth: 1.8, color: new THREE.Color(0.72, 0.6, 0.45), colorEnd: new THREE.Color(0.55, 0.45, 0.33), baseSize: 1.0, life: 1.8, alpha: 0.2, budgetShare: 0.16 },
  gravel: { sprite: 'leaf', additive: false, gravity: -9, drag: 0.4, growth: 0, color: new THREE.Color(0.5, 0.42, 0.34), colorEnd: new THREE.Color(0.4, 0.34, 0.28), baseSize: 0.12, life: 1.1, alpha: 1, budgetShare: 0.08 },
  grass: { sprite: 'leaf', additive: false, gravity: -6, drag: 0.8, growth: 0, color: new THREE.Color(0.35, 0.55, 0.2), colorEnd: new THREE.Color(0.3, 0.4, 0.15), baseSize: 0.14, life: 1.0, alpha: 1, budgetShare: 0.06 },
  snowdust: { sprite: 'smoke', additive: false, gravity: -0.3, drag: 1.3, growth: 2.0, color: new THREE.Color(0.95, 0.96, 1.0), colorEnd: new THREE.Color(0.85, 0.88, 0.95), baseSize: 1.3, life: 1.8, alpha: 0.6, budgetShare: 0.08 },
  spark: { sprite: 'spark', additive: true, gravity: -7, drag: 0.6, growth: 0, color: new THREE.Color(1.0, 0.85, 0.45), colorEnd: new THREE.Color(1.0, 0.3, 0.05), baseSize: 0.12, life: 0.7, alpha: 1, budgetShare: 0.1 },
  exhaust: { sprite: 'flare', additive: true, gravity: 0.5, drag: 3, growth: 1.5, color: new THREE.Color(1.0, 0.6, 0.15), colorEnd: new THREE.Color(0.4, 0.1, 0.5), baseSize: 0.3, life: 0.25, alpha: 1, budgetShare: 0.05 },
  spray: { sprite: 'splash', additive: false, gravity: -1.5, drag: 1.0, growth: 2.4, color: new THREE.Color(0.85, 0.9, 0.95), colorEnd: new THREE.Color(0.7, 0.75, 0.82), baseSize: 0.9, life: 1.3, alpha: 0.38, budgetShare: 0.12 },
  splash: { sprite: 'splash', additive: false, gravity: -5, drag: 0.8, growth: 1.2, color: new THREE.Color(0.9, 0.95, 1.0), colorEnd: new THREE.Color(0.75, 0.8, 0.9), baseSize: 0.35, life: 0.7, alpha: 0.6, budgetShare: 0.04 },
  debris: { sprite: 'leaf', additive: false, gravity: -9, drag: 0.5, growth: 0, color: new THREE.Color(0.25, 0.25, 0.28), colorEnd: new THREE.Color(0.15, 0.15, 0.17), baseSize: 0.16, life: 1.6, alpha: 1, budgetShare: 0.03 },
}

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute float aRot;
attribute vec3 aColor;
varying float vAlpha;
varying float vRot;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vRot = aRot;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (600.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}`

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying float vAlpha;
varying float vRot;
varying vec3 vColor;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float c = cos(vRot); float s = sin(vRot);
  uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y) + 0.5;
  vec4 t = texture2D(uMap, uv);
  if (t.a * vAlpha < 0.01) discard;
  gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
}`

class ParticleGroup {
  readonly points: THREE.Points
  private readonly capacity: number
  private readonly pos: Float32Array
  private readonly vel: Float32Array
  private readonly size: Float32Array
  private readonly alpha: Float32Array
  private readonly rot: Float32Array
  private readonly rotVel: Float32Array
  private readonly color: Float32Array
  private readonly age: Float32Array
  private readonly life: Float32Array
  private readonly startSize: Float32Array
  private head = 0
  private alive = 0
  private readonly geometry: THREE.BufferGeometry
  private readonly material: THREE.ShaderMaterial

  constructor(readonly cfg: ParticleGroupConfig, capacity: number, map: THREE.Texture) {
    this.capacity = capacity
    this.pos = new Float32Array(capacity * 3)
    this.vel = new Float32Array(capacity * 3)
    this.size = new Float32Array(capacity)
    this.alpha = new Float32Array(capacity)
    this.rot = new Float32Array(capacity)
    this.rotVel = new Float32Array(capacity)
    this.color = new Float32Array(capacity * 3)
    this.age = new Float32Array(capacity).fill(1e9)
    this.life = new Float32Array(capacity).fill(1)
    this.startSize = new Float32Array(capacity)
    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage))
    this.geometry.setAttribute('aRot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage))
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage))
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: cfg.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    })
    this.points = new THREE.Points(this.geometry, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = cfg.additive ? 20 : 10
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, sizeScale: number, lifeScale: number, colorMul: THREE.Color | null, spread: number): void {
    const i = this.head
    this.head = (this.head + 1) % this.capacity
    this.pos[i * 3] = p.x + (Math.random() - 0.5) * spread
    this.pos[i * 3 + 1] = p.y + (Math.random() - 0.5) * spread * 0.5
    this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * spread
    this.vel[i * 3] = v.x
    this.vel[i * 3 + 1] = v.y
    this.vel[i * 3 + 2] = v.z
    this.age[i] = 0
    this.life[i] = this.cfg.life * lifeScale * (0.7 + Math.random() * 0.6)
    this.startSize[i] = this.cfg.baseSize * sizeScale * (0.7 + Math.random() * 0.6)
    this.size[i] = this.startSize[i]
    this.rot[i] = Math.random() * Math.PI * 2
    this.rotVel[i] = (Math.random() - 0.5) * 2
    const c = this.cfg.color
    this.color[i * 3] = c.r * (colorMul?.r ?? 1)
    this.color[i * 3 + 1] = c.g * (colorMul?.g ?? 1)
    this.color[i * 3 + 2] = c.b * (colorMul?.b ?? 1)
    this.alpha[i] = this.cfg.alpha
    this.alive = Math.min(this.capacity, this.alive + 1)
  }

  update(dt: number, wind: THREE.Vector3): void {
    const cfg = this.cfg
    const dragK = Math.exp(-cfg.drag * dt)
    for (let i = 0; i < this.capacity; i++) {
      if (this.age[i] > this.life[i]) {
        this.alpha[i] = 0
        continue
      }
      this.age[i] += dt
      const t = this.age[i] / this.life[i]
      this.vel[i * 3] = this.vel[i * 3] * dragK + wind.x * dt
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dragK - cfg.gravity * -dt
      this.vel[i * 3 + 2] = this.vel[i * 3 + 2] * dragK + wind.z * dt
      this.pos[i * 3] += this.vel[i * 3] * dt
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt
      if (cfg.gravity < 0 && this.pos[i * 3 + 1] < -0.02 && cfg.growth === 0) {
        // Ground particles die on impact.
        this.age[i] = this.life[i] + 1
        this.alpha[i] = 0
        continue
      }
      this.size[i] = this.startSize[i] * (1 + cfg.growth * t)
      this.rot[i] += this.rotVel[i] * dt
      const fade = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88
      this.alpha[i] = cfg.alpha * fade
      const ce = cfg.colorEnd
      const c = cfg.color
      this.color[i * 3] = c.r + (ce.r - c.r) * t
      this.color[i * 3 + 1] = c.g + (ce.g - c.g) * t
      this.color[i * 3 + 2] = c.b + (ce.b - c.b) * t
    }
    for (const name of ['position', 'aSize', 'aAlpha', 'aRot', 'aColor']) (this.geometry.attributes[name] as THREE.BufferAttribute).needsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}

export class ParticleSystem {
  private readonly groups = new Map<ParticleKind, ParticleGroup>()
  readonly root = new THREE.Group()
  wind = new THREE.Vector3()
  private budget: number
  private emitAccumulator = new Map<string, number>()

  constructor(private readonly textures: TextureFactory, budget: number) {
    this.budget = budget
    this.root.name = 'particles'
    this.build()
  }

  private build(): void {
    for (const g of this.groups.values()) {
      this.root.remove(g.points)
      g.dispose()
    }
    this.groups.clear()
    for (const kind of Object.keys(CONFIG) as ParticleKind[]) {
      const cfg = CONFIG[kind]
      const cap = Math.max(32, Math.floor(this.budget * cfg.budgetShare))
      const group = new ParticleGroup(cfg, cap, this.textures.sprite(cfg.sprite))
      this.groups.set(kind, group)
      this.root.add(group.points)
    }
  }

  setBudget(budget: number): void {
    if (budget === this.budget) return
    this.budget = budget
    this.build()
  }

  /** Emit `count` particles. Fractional counts accumulate so low rates still emit over time. */
  emit(kind: ParticleKind, position: THREE.Vector3, velocity: THREE.Vector3, count: number, opts: { size?: number; life?: number; color?: THREE.Color; spread?: number; key?: string } = {}): void {
    const g = this.groups.get(kind)
    if (!g) return
    let n = count
    if (opts.key) {
      const acc = (this.emitAccumulator.get(opts.key) ?? 0) + count
      n = Math.floor(acc)
      this.emitAccumulator.set(opts.key, acc - n)
    }
    for (let i = 0; i < n; i++) g.emit(position, velocity, opts.size ?? 1, opts.life ?? 1, opts.color ?? null, opts.spread ?? 0.3)
  }

  burst(kind: ParticleKind, position: THREE.Vector3, count: number, speed: number, opts: { size?: number; life?: number; color?: THREE.Color; dir?: THREE.Vector3 } = {}): void {
    const g = this.groups.get(kind)
    if (!g) return
    const v = new THREE.Vector3()
    for (let i = 0; i < count; i++) {
      v.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8))
      if (opts.dir) v.addScaledVector(opts.dir, speed * 0.6)
      g.emit(position, v, opts.size ?? 1, opts.life ?? 1, opts.color ?? null, 0.2)
    }
  }

  update(dt: number): void {
    for (const g of this.groups.values()) g.update(dt, this.wind)
  }

  dispose(): void {
    for (const g of this.groups.values()) g.dispose()
    this.groups.clear()
  }
}

export class PrecipitationSystem {
  readonly points: THREE.Points
  private readonly count: number
  private readonly pos: Float32Array
  private readonly speeds: Float32Array
  private readonly material: THREE.ShaderMaterial
  private mode: 'rain' | 'snow' = 'rain'
  private intensity = 0
  private readonly box = new THREE.Vector3(60, 30, 60)

  constructor(textures: TextureFactory, count: number) {
    this.count = count
    this.pos = new Float32Array(count * 3)
    this.speeds = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      this.pos[i * 3] = (Math.random() - 0.5) * this.box.x
      this.pos[i * 3 + 1] = Math.random() * this.box.y
      this.pos[i * 3 + 2] = (Math.random() - 0.5) * this.box.z
      this.speeds[i] = 0.6 + Math.random() * 0.6
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: textures.sprite('drop') },
        uSize: { value: 2.0 },
        uAlpha: { value: 0 },
        uStretch: { value: 3.0 },
        uColor: { value: new THREE.Color(0.8, 0.85, 0.95) },
      },
      vertexShader: /* glsl */ `
        uniform float uSize; uniform float uStretch;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = uSize * (300.0 / max(1.0,-mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; uniform float uAlpha; uniform vec3 uColor;
        void main(){
          vec4 t = texture2D(uMap, gl_PointCoord);
          if (t.a * uAlpha < 0.02) discard;
          gl_FragColor = vec4(uColor, t.a * uAlpha);
        }`,
      transparent: true,
      depthWrite: false,
    })
    this.points = new THREE.Points(geo, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = 30
    this.points.visible = false
  }

  setMode(mode: 'rain' | 'snow', textures: TextureFactory): void {
    if (mode === this.mode) return
    this.mode = mode
    this.material.uniforms.uMap.value = textures.sprite(mode === 'rain' ? 'drop' : 'flake')
    this.material.uniforms.uSize.value = mode === 'rain' ? 2.2 : 3.5
    this.material.uniforms.uColor.value.set(mode === 'rain' ? 0xc8d4e8 : 0xffffff)
  }

  setIntensity(v: number): void {
    this.intensity = v
    this.points.visible = v > 0.01
    this.material.uniforms.uAlpha.value = (this.mode === 'rain' ? 0.35 : 0.8) * Math.min(1, v)
  }

  update(dt: number, camera: THREE.Camera, cameraVelocity: THREE.Vector3): void {
    if (!this.points.visible) return
    const fall = this.mode === 'rain' ? 26 : 2.5
    const drift = this.mode === 'rain' ? 3 : 1.2
    const bx = this.box.x
    const by = this.box.y
    const bz = this.box.z
    const cx = camera.position.x + cameraVelocity.x * 0.4
    const cy = camera.position.y
    const cz = camera.position.z + cameraVelocity.z * 0.4
    const active = Math.floor(this.count * Math.min(1, this.intensity))
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3
      if (i >= active) {
        this.pos[i3 + 1] = -1000
        continue
      }
      this.pos[i3 + 1] -= fall * this.speeds[i] * dt
      this.pos[i3] += drift * dt * (this.mode === 'snow' ? Math.sin(i + this.pos[i3 + 1]) : 1)
      // Wrap in the camera-centred box.
      let x = this.pos[i3] - cx
      let y = this.pos[i3 + 1] - cy
      let z = this.pos[i3 + 2] - cz
      if (y < -8) {
        y += by
        x = (Math.random() - 0.5) * bx
        z = (Math.random() - 0.5) * bz
      }
      if (y < -1000) y = Math.random() * by
      if (x > bx / 2) x -= bx
      else if (x < -bx / 2) x += bx
      if (z > bz / 2) z -= bz
      else if (z < -bz / 2) z += bz
      this.pos[i3] = x + cx
      this.pos[i3 + 1] = y + cy
      this.pos[i3 + 2] = z + cz
    }
    ;(this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  dispose(): void {
    this.points.geometry.dispose()
    this.material.dispose()
  }
}
