/**
 * Post-processing pipeline: render → ambient occlusion (GTAO) → bloom →
 * speed blur / vignette / colour grade / chromatic aberration → anti-aliasing
 * → output tone mapping. Passes are toggled by the resolved quality tier so the
 * same pipeline scales from phones to desktops.
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js'
import type { ResolvedQuality } from '../core/Settings'
import { damp } from '../core/MathUtils'

const SpeedGradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uBlur: { value: 0 },
    uCenter: { value: new THREE.Vector2(0.5, 0.55) },
    uVignette: { value: 0.35 },
    uSaturation: { value: 1.08 },
    uContrast: { value: 1.06 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uAberration: { value: 0.0 },
    uFlash: { value: 0 },
    uDamage: { value: 0 },
    uTime: { value: 0 },
    uWet: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uBlur; uniform vec2 uCenter; uniform float uVignette; uniform float uSaturation; uniform float uContrast;
    uniform vec3 uTint; uniform float uAberration; uniform float uFlash; uniform float uDamage; uniform float uTime; uniform float uWet;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    void main(){
      vec2 dir = vUv - uCenter;
      float dist = length(dir);
      // Rain-on-lens ripple when wet.
      vec2 uv = vUv;
      if (uWet > 0.01) {
        float n = hash(floor(vUv * 40.0) + floor(uTime * 2.0));
        uv += (n - 0.5) * 0.004 * uWet * smoothstep(0.4, 0.9, hash(floor(vUv * 12.0)));
      }
      vec3 col = vec3(0.0);
      if (uBlur > 0.001) {
        const int SAMPLES = 8;
        float total = 0.0;
        for (int i = 0; i < SAMPLES; i++) {
          float t = float(i) / float(SAMPLES - 1);
          float w = 1.0 - t * 0.5;
          vec2 offset = dir * t * uBlur * dist * 0.9;
          col += texture2D(tDiffuse, uv - offset).rgb * w;
          total += w;
        }
        col /= total;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }
      if (uAberration > 0.0001) {
        vec2 ab = dir * uAberration * dist;
        col.r = texture2D(tDiffuse, uv + ab).r;
        col.b = texture2D(tDiffuse, uv - ab).b;
      }
      // Grade.
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(luma), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;
      col *= uTint;
      // Vignette.
      float v = smoothstep(0.95, 0.35, dist * (1.0 + uVignette));
      col *= mix(1.0, v, uVignette + uDamage * 0.4);
      // Damage red edge.
      col = mix(col, vec3(0.6, 0.05, 0.02), uDamage * (1.0 - v) * 0.8);
      col += uFlash;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
}

const _size = new THREE.Vector2()
const _size2 = new THREE.Vector2()

export class PostPipeline {
  private composer: EffectComposer
  private renderPass: RenderPass
  private bloom: UnrealBloomPass | null = null
  private gtao: GTAOPass | null = null
  private grade: ShaderPass
  private smaa: SMAAPass | null = null
  private fxaa: ShaderPass | null = null
  private output: OutputPass
  private blur = 0
  private flash = 0
  private time = 0
  enabled = true
  /** Use 8-bit render targets (fallback for GPUs/drivers that cannot blend into half-float targets). */
  ldr = false

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private quality: ResolvedQuality,
  ) {
    this.composer = this.createComposer()
    this.renderPass = new RenderPass(scene, camera)
    this.grade = new ShaderPass(SpeedGradeShader)
    this.output = new OutputPass()
    this.build()
  }

  private createComposer(): EffectComposer {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    const target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: this.ldr ? THREE.UnsignedByteType : THREE.HalfFloatType })
    const composer = new EffectComposer(this.renderer, target)
    return composer
  }

  /** Force the bloom pass's internal mip targets to the composer's precision. */
  private applyBloomPrecision(): void {
    if (!this.bloom) return
    const type = this.ldr ? THREE.UnsignedByteType : THREE.HalfFloatType
    const fix = (rt: THREE.WebGLRenderTarget) => {
      if (rt.texture.type !== type) {
        rt.texture.type = type
        rt.dispose()
      }
    }
    fix(this.bloom.renderTargetBright)
    this.bloom.renderTargetsHorizontal.forEach(fix)
    this.bloom.renderTargetsVertical.forEach(fix)
  }

  /**
   * Render the scene once directly and once through the composer and compare
   * brightness. If the composer output is black while the direct render is not,
   * switch to 8-bit targets (some drivers cannot blend into half-float buffers).
   * Returns true when a fallback was applied.
   */
  selfTest(): boolean {
    const gl = this.renderer.getContext()
    const sample = (): number => {
      const w = gl.drawingBufferWidth
      const h = gl.drawingBufferHeight
      const px = new Uint8Array(4)
      let sum = 0
      for (const [x, y] of [[0.5, 0.5], [0.3, 0.4], [0.7, 0.6], [0.5, 0.75], [0.2, 0.7]]) {
        gl.readPixels(Math.floor(w * x), Math.floor(h * y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
        sum += px[0] + px[1] + px[2]
      }
      return sum
    }
    try {
      this.renderer.render(this.scene, this.camera)
      const direct = sample()
      this.composer.render(0.016)
      const post = sample()
      if (direct > 30 && post < 3) {
        this.ldr = true
        return true
      }
    } catch {
      /* readback not available — leave the pipeline as is */
    }
    return false
  }


  private build(): void {
    const q = this.quality
    this.composer.passes.length = 0
    this.composer.addPass(this.renderPass)
    const size = this.renderer.getSize(new THREE.Vector2())
    if (q.ssao) {
      this.gtao = new GTAOPass(this.scene, this.camera, size.x, size.y)
      this.gtao.output = GTAOPass.OUTPUT.Default
      this.gtao.blendIntensity = 0.7
      this.gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.5, thickness: 1.2, scale: 1.2, samples: 12, distanceFallOff: 1 })
      this.composer.addPass(this.gtao)
    } else this.gtao = null
    if (q.bloom) {
      this.bloom = new UnrealBloomPass(size, 0.35, 0.45, 1.0)
      this.composer.addPass(this.bloom)
      this.applyBloomPrecision()
    } else this.bloom = null
    this.composer.addPass(this.grade)
    if (q.antialias === 'smaa') {
      this.smaa = new SMAAPass(size.x, size.y)
      this.composer.addPass(this.smaa)
      this.fxaa = null
    } else if (q.antialias === 'fxaa') {
      this.fxaa = new ShaderPass(FXAAShader)
      this.fxaa.material.uniforms.resolution.value.set(1 / size.x, 1 / size.y)
      this.composer.addPass(this.fxaa)
      this.smaa = null
    } else {
      this.smaa = null
      this.fxaa = null
    }
    this.composer.addPass(this.output)
  }

  setQuality(q: ResolvedQuality): void {
    this.quality = q
    this.build()
  }

  setCamera(camera: THREE.PerspectiveCamera): void {
    this.camera = camera
    this.renderPass.camera = camera
    if (this.gtao) this.gtao.camera = camera
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio)
    this.composer.setSize(width, height)
    this.fxaa?.material.uniforms.resolution.value.set(1 / (width * pixelRatio), 1 / (height * pixelRatio))
    this.gtao?.setSize(width, height)
  }

  /** Speed factor 0..1 drives radial blur + chromatic aberration. */
  setSpeed(speedFactor: number, boosting: boolean): void {
    const target = this.quality.motionBlur ? Math.max(0, speedFactor - 0.45) * 0.9 + (boosting ? 0.35 : 0) : 0
    this.blur = damp(this.blur, target, 6, 1 / 60)
  }

  setEnvironment(nightFactor: number, wetness: number, damage: number, temperature: 'warm' | 'cool' | 'neutral'): void {
    const u = this.grade.uniforms
    u.uWet.value = wetness * 0.6
    u.uDamage.value = damage > 0.6 ? (damage - 0.6) * 2 : 0
    const tint = u.uTint.value as THREE.Color
    if (temperature === 'warm') tint.setRGB(1.04, 0.99, 0.94)
    else if (temperature === 'cool') tint.setRGB(0.95, 0.99, 1.06)
    else tint.setRGB(1, 1, 1)
    tint.lerp(new THREE.Color(0.9, 0.95, 1.1), nightFactor * 0.35)
    u.uSaturation.value = 1.08 - nightFactor * 0.1
    if (this.bloom) {
      // Only genuine HDR highlights (sun, lamps, neon, brake lights) bloom.
      this.bloom.strength = 0.3 + nightFactor * 0.45
      this.bloom.threshold = 1.0 - nightFactor * 0.15
    }
  }

  triggerFlash(intensity: number): void {
    this.flash = Math.max(this.flash, intensity)
  }

  render(dt: number): void {
    this.time += dt
    // Keep composer targets in sync with the drawing buffer (dynamic resolution changes).
    const size = this.renderer.getDrawingBufferSize(_size)
    if (this.composer.renderTarget1.width !== size.x || this.composer.renderTarget1.height !== size.y) {
      const css = this.renderer.getSize(_size2)
      this.setSize(css.x, css.y, this.renderer.getPixelRatio())
    }
    const u = this.grade.uniforms
    u.uBlur.value = this.blur
    u.uAberration.value = this.blur * 0.02
    u.uTime.value = this.time
    u.uFlash.value = this.flash
    this.flash = damp(this.flash, 0, 8, dt)
    // In LDR fallback mode linear HDR values would clip in 8-bit targets before tone mapping,
    // so render directly (tone-mapped by the renderer) and skip the screen-space effects.
    if (this.enabled && !this.ldr) this.composer.render(dt)
    else this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.composer.dispose()
    this.bloom?.dispose()
    this.gtao?.dispose()
    this.grade.dispose()
    this.smaa?.dispose()
    this.output.dispose()
  }
}
