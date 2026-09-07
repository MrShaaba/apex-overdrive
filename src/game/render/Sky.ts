/**
 * Sky, sun, time of day and image-based lighting.
 *
 * Uses three's physically based `Sky` shader for the dome, drives a shadow
 * casting directional sun + hemisphere fill from the solar elevation, and bakes
 * the sky into a PMREM environment map for reflections on car paint. The
 * environment is re-baked only when the light changes meaningfully, keeping
 * the cost negligible during a race.
 *
 * When an equirectangular .hdr panorama is available (`loadHdri`), it is
 * PMREM-filtered once and used as the environment instead of the sky bake:
 * real-world sky/ground detail lights the bodywork and shows in reflections.
 * The panorama is rotated every frame so its sun stays aligned with the
 * procedural sun, and dimmed with the time of day. The sky dome itself stays
 * procedural (it is the visible background and follows the clock).
 */

import * as THREE from 'three'
import { Sky } from 'three/examples/jsm/objects/Sky.js'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils'
import type { TrackEnvironment } from '../tracks/TrackCatalog'
import type { WeatherVisualState } from './Weather'

export class SkySystem {
  readonly sky: Sky
  readonly sun: THREE.DirectionalLight
  readonly hemi: THREE.HemisphereLight
  readonly moon: THREE.DirectionalLight
  readonly fog: THREE.FogExp2
  hour: number
  /** Hours of game time per real second (0 = frozen). */
  timeRate = 0
  nightFactor = 0
  private pmrem: THREE.PMREMGenerator
  private envTarget: THREE.WebGLRenderTarget | null = null
  private hdrTarget: THREE.WebGLRenderTarget | null = null
  /** Equirect longitude (radians, three's `equirectUv` convention) of the sun in the loaded panorama. */
  private hdrSunLongitude = 0
  /**
   * Multiplier on the panorama's brightness (the sky bake is untouched). The
   * bundled overcast-dawn panorama is much dimmer than the physical sky bake,
   * so 2.5 keeps the world's exposure where it was while the soft cloud dome
   * reads on bodywork; beyond ~4 the grass and track wash out.
   */
  hdriIntensity = 2.5
  private hdriEnabled = true
  private lastBakeHour = -99
  private lastBakeCloud = -1
  private bakeCooldown = 0
  private readonly sunPos = new THREE.Vector3()
  private baseFog = 0.0025
  private skyTint = new THREE.Color('#8fc5ff')
  private groundColor = new THREE.Color('#4d6a3a')
  private shadowSize = 2048
  private shadowDistance = 100
  private readonly fogColor = new THREE.Color()

  constructor(
    private readonly scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    hour: number,
    envSize: number,
  ) {
    this.hour = hour
    void envSize
    this.sky = new Sky()
    this.sky.scale.setScalar(45000)
    scene.add(this.sky)
    const u = this.sky.material.uniforms
    u.turbidity.value = 4
    u.rayleigh.value = 1.6
    u.mieCoefficient.value = 0.006
    u.mieDirectionalG.value = 0.8

    this.sun = new THREE.DirectionalLight(0xffffff, 3)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(this.shadowSize, this.shadowSize)
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 400
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.05
    scene.add(this.sun, this.sun.target)

    this.moon = new THREE.DirectionalLight(0x8fa8ff, 0)
    scene.add(this.moon)

    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4d6a3a, 0.8)
    scene.add(this.hemi)

    this.fog = new THREE.FogExp2(0x9fbfe0, this.baseFog)
    scene.fog = this.fog
    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.pmrem.compileEquirectangularShader()
  }

  applyTheme(env: TrackEnvironment): void {
    this.baseFog = env.fogDensity
    this.skyTint.set(env.skyTint)
    this.groundColor.set(env.groundColor)
    this.hemi.groundColor.copy(this.groundColor)
    this.hour = env.defaultHour
    this.lastBakeHour = -99
  }

  configureShadows(size: number, distance: number, enabled: boolean): void {
    this.shadowSize = size
    this.shadowDistance = distance
    this.sun.castShadow = enabled
    this.sun.shadow.mapSize.set(size, size)
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose()
      this.sun.shadow.map = null
    }
    const cam = this.sun.shadow.camera
    cam.left = -distance
    cam.right = distance
    cam.top = distance
    cam.bottom = -distance
    cam.updateProjectionMatrix()
  }

  setEnvSize(size: number): void {
    void size
    this.lastBakeHour = -99
  }

  /**
   * Load an equirectangular Radiance (.hdr) panorama as the image-based
   * lighting environment. Resolves false (and keeps the procedural sky bake)
   * if the file is missing or fails to parse, so the game runs without it.
   * `sunLongitudeDeg` is the panorama's brightest texel expressed as
   * (u - 0.5) * 360, printed by tools/asset-pipeline/convert-hdri.mjs.
   */
  async loadHdri(url: string, sunLongitudeDeg: number): Promise<boolean> {
    try {
      const tex = await new RGBELoader().loadAsync(url)
      tex.mapping = THREE.EquirectangularReflectionMapping
      const target = this.pmrem.fromEquirectangular(tex)
      tex.dispose()
      this.hdrTarget?.dispose()
      this.hdrTarget = target
      this.hdrSunLongitude = THREE.MathUtils.degToRad(sunLongitudeDeg)
      // Re-apply on the next update so the new environment takes over at once.
      this.lastBakeHour = -99
      this.bakeCooldown = 0
      return true
    } catch (err) {
      console.warn('[Sky] HDRI environment unavailable, using the procedural sky bake', err)
      return false
    }
  }

  get hasHdri(): boolean {
    return this.hdrTarget !== null
  }

  /** Factor other systems apply when they set `scene.environmentIntensity` directly. */
  get envBoost(): number {
    return this.activeHdr ? this.hdriIntensity : 1
  }

  /** Switch between the panorama and the procedural sky bake (QA / options). */
  setHdriEnabled(on: boolean): void {
    if (this.hdriEnabled === on) return
    this.hdriEnabled = on
    this.lastBakeHour = -99
    this.bakeCooldown = 0
  }

  private get activeHdr(): THREE.WebGLRenderTarget | null {
    return this.hdriEnabled ? this.hdrTarget : null
  }

  private computeSun(): void {
    const dayT = (this.hour / 24) * Math.PI * 2 - Math.PI / 2
    const elevation = Math.sin(dayT) * 70 + 8 // degrees; peak ~78° at noon, -62 at midnight
    const azimuth = 180 + Math.cos(dayT) * 90
    const phi = THREE.MathUtils.degToRad(90 - elevation)
    const theta = THREE.MathUtils.degToRad(azimuth)
    this.sunPos.setFromSphericalCoords(1, phi, theta)
  }

  update(dt: number, weather: WeatherVisualState, focus: THREE.Vector3, cameraForward: THREE.Vector3): void {
    if (this.timeRate > 0) this.hour = (this.hour + dt * this.timeRate) % 24
    this.computeSun()
    const elevationDeg = THREE.MathUtils.radToDeg(Math.asin(clamp(this.sunPos.y, -1, 1)))
    const day = smoothstep(-6, 10, elevationDeg)
    this.nightFactor = 1 - day
    const cloud = weather.cloudCover

    const u = this.sky.material.uniforms
    u.sunPosition.value.copy(this.sunPos)
    u.turbidity.value = lerp(2.5, 14, cloud)
    u.rayleigh.value = lerp(1.2, 0.5, cloud) * lerp(1, 2.2, smoothstep(12, -4, elevationDeg))
    u.mieCoefficient.value = lerp(0.005, 0.03, cloud)
    u.mieDirectionalG.value = lerp(0.8, 0.95, cloud)

    // Lighting.
    const sunIntensity = lerp(0.05, 2.6, day) * lerp(1, 0.3, cloud) + weather.lightning * 6
    this.sun.intensity = sunIntensity
    const warm = smoothstep(25, -2, elevationDeg)
    this.sun.color.setRGB(1, lerp(0.98, 0.6, warm), lerp(0.92, 0.35, warm))
    this.sun.position.copy(this.sunPos).multiplyScalar(180).add(focus)
    // Bias the shadow frustum ahead of the camera so the visible road gets the resolution.
    const shadowFocus = focus.clone().addScaledVector(cameraForward, this.shadowDistance * 0.35)
    this.sun.target.position.copy(shadowFocus)
    this.sun.position.copy(this.sunPos).multiplyScalar(180).add(shadowFocus)
    this.moon.intensity = lerp(0.35, 0, day) * lerp(1, 0.3, cloud)
    this.moon.position.copy(this.sunPos).multiplyScalar(-150).add(focus)
    this.moon.position.y = Math.abs(this.moon.position.y) + 60

    this.hemi.intensity = lerp(0.12, 0.55, day) * lerp(1, 0.75, cloud) + weather.lightning * 0.5
    this.hemi.color.copy(this.skyTint).lerp(new THREE.Color(0x101828), this.nightFactor * 0.85).lerp(new THREE.Color(0x8a8f99), cloud * 0.5)

    // Fog.
    this.fogColor.copy(this.skyTint).lerp(new THREE.Color(0xffb27a), warm * 0.5 * (1 - cloud)).lerp(new THREE.Color(0x0a0e18), this.nightFactor * 0.92).lerp(new THREE.Color(0x9aa3ad), cloud * 0.55 * day)
    if (weather.snowCover > 0.5) this.fogColor.lerp(new THREE.Color(0xdfe7f0), 0.3 * day)
    this.fog.color.copy(this.fogColor)
    this.fog.density = this.baseFog * weather.fogMultiplier * lerp(1, 1.3, this.nightFactor)
    this.scene.background = this.fogColor.clone().lerp(new THREE.Color(0x000000), this.nightFactor * 0.3)
    // Keep the physical sky visible above the fog: background is only used when the sky dome is culled.
    this.scene.background = null

    // Environment bake — throttled.
    this.bakeCooldown -= dt
    if (this.bakeCooldown <= 0 && (Math.abs(this.hour - this.lastBakeHour) > 0.2 || Math.abs(cloud - this.lastBakeCloud) > 0.15)) {
      this.bakeEnvironment()
      this.lastBakeHour = this.hour
      this.lastBakeCloud = cloud
      this.bakeCooldown = 1.5
    }
    if (this.activeHdr) {
      // Spin the panorama so its sun sits where the procedural sun is. The
      // shader samples the map at R(y)·dir, which shifts longitudes by -ρ, so
      // ρ = sunLongitude - panoramaSunLongitude puts the two suns together.
      const sunLongitude = Math.atan2(this.sunPos.z, this.sunPos.x)
      this.scene.environmentRotation.set(0, sunLongitude - this.hdrSunLongitude, 0)
      // Real sky detail is brighter than the dome bake: keep the daytime level
      // and fade further at night, when the dawn panorama would look wrong.
      this.scene.environmentIntensity = lerp(0.08, 0.8, 1 - this.nightFactor) * lerp(1, 0.7, cloud) * this.hdriIntensity
    }
  }

  private bakeEnvironment(): void {
    const hdr = this.activeHdr
    if (hdr) {
      this.scene.environment = hdr.texture
      return
    }
    this.scene.environmentRotation.set(0, 0, 0)
    try {
      const old = this.envTarget
      const sky = this.sky
      // Bake the dome alone at modest resolution.
      const scene = new THREE.Scene()
      scene.add(sky)
      const target = this.pmrem.fromScene(scene, 0.04, 0.1, 100)
      this.scene.add(sky)
      this.envTarget = target
      this.scene.environment = target.texture
      this.scene.environmentIntensity = lerp(0.25, 0.8, 1 - this.nightFactor)
      old?.dispose()
    } catch (err) {
      console.warn('[Sky] environment bake failed', err)
    }
  }

  /** 0..1 how bright it is (drives headlights, street lights, neon, HUD tint). */
  get daylight(): number {
    return clamp01(1 - this.nightFactor)
  }

  dispose(): void {
    this.envTarget?.dispose()
    this.hdrTarget?.dispose()
    this.pmrem.dispose()
    this.sky.geometry.dispose()
    ;(this.sky.material as THREE.Material).dispose()
    this.scene.remove(this.sky, this.sun, this.sun.target, this.hemi, this.moon)
  }
}
