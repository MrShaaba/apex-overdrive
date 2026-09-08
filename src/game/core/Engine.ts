/**
 * Engine — the orchestrator.
 *
 * Owns the renderer, physics world, audio, input, weather/sky, particles,
 * camera rig and post pipeline. Builds tracks and vehicles for a `RaceConfig`,
 * drives the fixed-step physics loop, pushes HUD state to the UI store at
 * ~20 Hz, records replays, plays ghosts, applies rewards on completion and
 * tears everything down cleanly between sessions.
 */

import * as THREE from 'three'
import { bus, type RaceResultSummary } from './EventBus'
import { Logger } from './Logger'
import { clamp, clamp01, damp, lerp } from './MathUtils'
import { resolveQuality, isTouchDevice, type CameraMode, type ResolvedQuality, type Settings } from './Settings'
import { PhysicsWorld } from '../physics/PhysicsWorld'
import { InputManager } from '../input/InputManager'
import { TextureFactory } from '../render/TextureFactory'
import { ParticleSystem, PrecipitationSystem } from '../render/Particles'
import { SkySystem } from '../render/Sky'
import { WeatherSystem } from '../render/Weather'
import { PostPipeline } from '../render/PostProcessing'
import { CameraRig } from '../render/CameraRig'
import { CockpitWheel } from '../render/CockpitWheel'
import { QualityManager } from '../render/QualityManager'
import { Showcase } from '../render/Showcase'
import { AudioEngine } from '../audio/AudioEngine'
import { saveManager } from '../persistence/SaveManager'
import { buildTrack, type BuiltTrack } from '../tracks/TrackBuilder'
import { getTrackDefinition, TRACK_CATALOG, type WeatherKind } from '../tracks/TrackCatalog'
import { Vehicle } from '../vehicles/Vehicle'
import { FORMULA_TEAMS, getVehicleSpec, VEHICLE_CATALOG } from '../vehicles/VehicleCatalog'
import { defaultCustomization, defaultUpgrades, type VehicleCustomization } from '../vehicles/VehicleSpec'
import { generateField, type DriverProfile } from '../ai/DriverProfiles'
import { RacingLine } from '../ai/RacingLine'
import { AIDriver, type AIContext, type AITrafficEntry } from '../ai/AIDriver'
import { RaceManager, createSeries, type SeriesState } from '../gameplay/RaceManager'
import { DIFFICULTY_SCALE, GAME_MODES, SERIES_POINTS, type RaceConfig } from '../gameplay/GameModes'
import { ReplayRecorder, GhostPlayer, REPLAY_RATE } from '../gameplay/Replay'
import { applyRaceRewards, ensureCarState } from '../gameplay/Progression'
import { evaluateAchievements } from '../gameplay/Achievements'
import { applyChallengeResult } from '../gameplay/Challenges'
import { leaderboards } from '../gameplay/Leaderboards'
import { captureFrame, storePhoto } from '../gameplay/PhotoMode'
import { recordCareerResult, SERIES_TRACKS, starsForResult } from '../gameplay/Career'
import { network } from '../net'
import { gameStore, navigate, pushToast, bumpProfile, initialHud, type HudStanding, type MinimapCar } from '../state/GameStore'
import { buildCarVisual, type CarVisual } from '../vehicles/CarMeshBuilder'
import { modelLibrary } from '../vehicles/CarModelLoader'

const log = Logger.scope('Engine')

/** Optional real-sky panorama for image-based lighting (see tools/asset-pipeline/convert-hdri.mjs). */
const SKY_HDRI = { file: 'assets/hdri/nqweba_dawn_2k.hdr', sunLongitudeDeg: 73.8 }
/** Licensed cockpit steering wheel (see tools/asset-pipeline/prepare-car.mjs, prop `wheel`); procedural rim when missing. */
const COCKPIT_WHEEL_MODEL = 'assets/models/cockpit/mclaren_wheel.glb'

type EngineMode = 'boot' | 'showcase' | 'loading' | 'race' | 'replay'

export class Engine {
  private static _instance: Engine | null = null
  static get(): Engine {
    if (!Engine._instance) Engine._instance = new Engine()
    return Engine._instance
  }

  canvas!: HTMLCanvasElement
  renderer!: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  physics!: PhysicsWorld
  readonly input = new InputManager()
  readonly textures = new TextureFactory()
  particles!: ParticleSystem
  precipitation!: PrecipitationSystem
  sky!: SkySystem
  weather!: WeatherSystem
  post!: PostPipeline
  readonly cameraRig = new CameraRig(16 / 9)
  private cockpitWheel: CockpitWheel | null = null
  audio: AudioEngine | null = null
  readonly qualityManager = new QualityManager()
  showcase!: Showcase
  quality!: ResolvedQuality
  settings!: Settings

  mode: EngineMode = 'boot'
  track: BuiltTrack | null = null
  vehicles: Vehicle[] = []
  player: Vehicle | null = null
  race: RaceManager | null = null
  racingLine: RacingLine | null = null
  config: RaceConfig | null = null
  series: SeriesState | null = null
  private replay = new ReplayRecorder(600)
  private ghost: GhostPlayer | null = null
  private ghostVisual: CarVisual | null = null
  private readonly showcaseCamera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500)
  private paused = false
  private lastTime = 0
  private hudAccumulator = 0
  private running = false
  private rafId = 0
  private elapsed = 0
  private replayTime = 0
  private replayPlaying = false
  private replaySpeed = 1
  private adaptiveSkill = 0.9
  private raceEnded = false
  private showcaseDrag = 0
  private raceStartTime = 0
  private frameCounter = 0
  private lightningWasHigh = false
  private lightPool: THREE.PointLight[] = []
  private aiProfiles: DriverProfile[] = []
  private playerDrs: 'none' | 'available' | 'active' = 'none'
  /** When true the player's car is driven by an AI brain (attract mode / QA). */
  autopilot = false
  private disposeListeners: (() => void)[] = []

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas
    const setLoading = (progress: number, label: string) => gameStore.set({ loading: { progress, label } })
    try {
      setLoading(0.05, 'Loading profile')
      await saveManager.load()
      this.settings = saveManager.get().settings
      this.quality = resolveQuality(this.settings.graphics)

      setLoading(0.15, 'Creating renderer')
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false })
      this.renderer.outputColorSpace = THREE.SRGBColorSpace
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping
      this.renderer.toneMappingExposure = 0.55
      this.renderer.shadowMap.enabled = this.quality.shadowsEnabled
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
      this.textures.setScale(this.quality.textureScale)
      this.textures.setAnisotropy(Math.min(this.quality.anisotropy, this.renderer.capabilities.getMaxAnisotropy()))
      modelLibrary.init(this.renderer)

      setLoading(0.3, 'Starting physics')
      this.physics = await PhysicsWorld.create()
      this.physics.onContact((e) => this.onContact(e.meta1, e.meta2, e.collider1, e.collider2, e.maxForce))

      setLoading(0.5, 'Building environment')
      this.sky = new SkySystem(this.scene, this.renderer, 14, this.quality.envMapSize)
      this.sky.configureShadows(this.quality.shadowMapSize, this.quality.shadowDistance, this.quality.shadowsEnabled)
      setLoading(0.55, 'Loading sky')
      if (!(await this.sky.loadHdri(`${import.meta.env.BASE_URL}${SKY_HDRI.file}`, SKY_HDRI.sunLongitudeDeg))) log.warn('Sky panorama missing — procedural sky environment in use')
      this.weather = new WeatherSystem('clear', ['clear'], false, false)
      this.particles = new ParticleSystem(this.textures, this.quality.particleBudget)
      this.scene.add(this.particles.root)
      this.precipitation = new PrecipitationSystem(this.textures, Math.round(this.quality.particleBudget * 1.2))
      this.scene.add(this.precipitation.points)
      this.post = new PostPipeline(this.renderer, this.scene, this.cameraRig.camera, this.quality)
      // The rig camera joins the scene so camera-parented objects (cockpit wheel) render.
      this.scene.add(this.cameraRig.camera)
      this.cockpitWheel = new CockpitWheel()
      this.cameraRig.camera.add(this.cockpitWheel.root)
      void modelLibrary.preload(COCKPIT_WHEEL_MODEL).then((ok) => {
        if (ok) this.cockpitWheel?.setModel(modelLibrary.get(COCKPIT_WHEEL_MODEL))
      })
      this.showcase = new Showcase(this.textures)
      for (let i = 0; i < 6; i++) {
        const l = new THREE.PointLight(0xffe6b0, 0, 40, 1.6)
        l.visible = false
        this.scene.add(l)
        this.lightPool.push(l)
      }

      setLoading(0.7, 'Warming audio')
      try {
        this.audio = new AudioEngine(this.settings.audio)
      } catch (err) {
        log.warn('Audio unavailable', err)
      }

      this.input.attachPointer(canvas)
      this.input.configure({ sensitivity: this.settings.controls.steeringSensitivity, deadzone: this.settings.controls.steeringDeadzone, tilt: this.settings.controls.touchLayout === 'tilt', tiltSensitivity: this.settings.controls.tiltSensitivity })
      this.input.touch.active = isTouchDevice()
      this.qualityManager.enabled = this.settings.graphics.dynamicScaling
      this.qualityManager.setMaxScale(this.quality.resolutionScale)
      this.qualityManager.onChange((scale) => {
        this.applyResolution(scale)
        gameStore.set({ quality: { preset: this.settings.graphics.preset, scale } })
      })
      window.addEventListener('resize', this.onResize)
      this.onResize()
      this.bindEvents()

      setLoading(0.9, 'Preparing garage')
      this.enterShowcase(saveManager.get().selectedCar)
      // Verify the post pipeline produces an image on this GPU; fall back to 8-bit targets if not.
      if (this.post.selfTest()) log.warn('Post pipeline disabled: this GPU/driver cannot blend into half-float targets — rendering directly')
      this.mode = 'showcase'
      this.running = true
      this.lastTime = performance.now()
      this.rafId = requestAnimationFrame(this.loop)
      setLoading(1, 'Ready')
      gameStore.set({ booted: true })
      navigate('menu')
      bumpProfile()
      bus.emit('engine:ready', { buildMs: performance.now() })
      if (import.meta.env.DEV) (window as unknown as { __apex: Engine }).__apex = this
      log.info('Engine ready')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('Boot failed', err)
      gameStore.set({ bootError: message })
      bus.emit('engine:error', { message, fatal: true })
    }
  }

  private bindEvents(): void {
    this.disposeListeners.push(
      bus.on('input:action', ({ action, pressed }) => {
        if (!pressed) return
        const s = gameStore.get()
        if (this.mode === 'race' || this.mode === 'replay') {
          if (action === 'pause') {
            if (s.photo.active) this.exitPhotoMode()
            else if (s.replay.active) this.stopReplay()
            else this.togglePause()
          }
          if (this.paused || s.photo.active) return
          if (action === 'camera') this.cycleCamera()
          if (action === 'reset') this.respawnPlayer()
          if (action === 'gearUp') this.player?.controller.shiftUp()
          if (action === 'gearDown') this.player?.controller.shiftDown()
          if (action === 'photo') this.enterPhotoMode()
          if (action === 'toggleHud') gameStore.set({ hudVisible: !s.hudVisible })
          if (action === 'replay' && this.race?.phase === 'finished') this.startReplay()
        }
      }),
      bus.on('race:message', (m) => {
        const id = Date.now() + Math.random()
        gameStore.set((st) => ({ messages: [...st.messages.slice(-3), { id, text: m.text, kind: m.kind, ttl: m.ttl ?? 2.5 }] }))
        window.setTimeout(() => gameStore.set((st) => ({ messages: st.messages.filter((x) => x.id !== id) })), (m.ttl ?? 2.5) * 1000)
      }),
      bus.on('race:complete', ({ results }) => this.onRaceComplete(results)),
      bus.on('ui:toast', ({ text, icon }) => pushToast(text, icon)),
      bus.on('progress:unlock', ({ title }) => pushToast(title, '🔓')),
      bus.on('progress:levelup', ({ level, rank }) => {
        pushToast(`Level ${level} — ${rank}`, '⭐')
        this.audio?.playUI('levelup')
      }),
      bus.on('challenge:complete', ({ title, reward }) => pushToast(`Challenge complete: ${title} (+${reward} CR)`, '🎯')),
      bus.on('race:countdown', ({ value }) => this.audio?.playCountdown(value === 0)),
      bus.on('race:checkpoint', () => this.audio?.playCheckpoint()),
      bus.on('save:written', () => bumpProfile()),
    )
    window.addEventListener('wheel', (e) => {
      if (gameStore.get().photo.active) this.cameraRig.zoom(e.deltaY * 0.01)
      else if (this.mode === 'showcase') this.showcaseDrag += e.deltaY * 0.0005
    }, { passive: true })
  }

  private onResize = (): void => {
    const w = window.innerWidth
    const h = window.innerHeight
    this.cameraRig.resize(w / h)
    this.showcaseCamera.aspect = w / h
    this.showcaseCamera.updateProjectionMatrix()
    this.applyResolution(this.qualityManager.scale)
  }

  private applyResolution(scale: number): void {
    const w = window.innerWidth
    const h = window.innerHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * scale
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(w, h, false)
    this.post.setSize(w, h, dpr)
  }

  applySettings(settings: Settings): void {
    this.settings = settings
    const prevQuality = this.quality
    this.quality = resolveQuality(settings.graphics)
    this.renderer.shadowMap.enabled = this.quality.shadowsEnabled
    this.sky.configureShadows(this.quality.shadowMapSize, this.quality.shadowDistance, this.quality.shadowsEnabled)
    this.sky.setEnvSize(this.quality.envMapSize)
    this.particles.setBudget(this.quality.particleBudget)
    this.post.setQuality(this.quality)
    this.post.selfTest()
    this.qualityManager.enabled = settings.graphics.dynamicScaling
    this.qualityManager.setMaxScale(this.quality.resolutionScale)
    this.cameraRig.fovBase = settings.graphics.fovBase
    this.applyResolution(this.qualityManager.scale)
    if (prevQuality.textureScale !== this.quality.textureScale) this.textures.setScale(this.quality.textureScale)
    this.audio?.applySettings(settings.audio)
    this.input.configure({ sensitivity: settings.controls.steeringSensitivity, deadzone: settings.controls.steeringDeadzone, tilt: settings.controls.touchLayout === 'tilt', tiltSensitivity: settings.controls.tiltSensitivity })
    if (this.player) {
      this.player.controller.assists = { abs: settings.controls.abs, tcs: settings.controls.tractionControl, esc: settings.controls.stabilityControl, autoTransmission: settings.controls.transmission === 'auto' }
      this.player.controller.fuelEnabled = settings.gameplay.fuelConsumption && this.config?.mode === 'endurance'
      this.player.controller.damageEnabled = settings.gameplay.damage !== 'off'
    }
    saveManager.update((p) => {
      p.settings = settings
    })
    bus.emit('engine:quality', { preset: settings.graphics.preset })
    gameStore.set({ quality: { preset: settings.graphics.preset, scale: this.qualityManager.scale } })
  }

  // ---------------------------------------------------------------------------
  // Showcase (menus)
  // ---------------------------------------------------------------------------

  enterShowcase(carId: string): void {
    this.scene.add(this.showcase.root)
    this.setShowcaseCar(carId)
    this.sky.hour = 21.5
    this.sky.timeRate = 0
    this.weather = new WeatherSystem('clear', ['clear'], false, false)
    this.scene.fog = null
    this.audio?.music.setMode('menu')
    this.audio?.music.setIntensity(0.35)
    this.audio?.setAmbience({ speedKmh: 0, rain: 0, crowd: 0, tunnel: 0.2, wind: 0 })
    this.showcaseCamera.position.set(7.5, 2.4, 7.5)
    this.showcaseCamera.lookAt(this.showcase.cameraTarget)
    this.post.setCamera(this.showcaseCamera)
    // One sky pass so an environment map exists for paint reflections in the studio.
    this.sky.update(0, this.weather.state, this.showcase.cameraTarget, new THREE.Vector3(0, 0, 1))
    this.mode = 'showcase'
  }

  setShowcaseCar(carId: string, customization?: VehicleCustomization): void {
    const spec = getVehicleSpec(carId)
    ensureCarState(carId)
    const state = saveManager.get().cars[carId]
    this.showcase.setCar(spec, customization ?? state?.customization ?? defaultCustomization(spec))
    gameStore.set({ showcaseCar: carId })
  }

  rotateShowcase(delta: number): void {
    this.showcaseDrag += delta
  }

  // ---------------------------------------------------------------------------
  // Race lifecycle
  // ---------------------------------------------------------------------------

  async startRace(config: RaceConfig): Promise<void> {
    if (this.mode === 'loading') return
    this.mode = 'loading'
    navigate('loading')
    gameStore.set({ loading: { progress: 0.02, label: 'Preparing session' }, raceConfig: config, results: null, rewards: null, paused: false, messages: [], hudVisible: true, replay: { active: false, playing: false, time: 0, duration: 0, speed: 1 }, photo: { active: false, lastCapture: null } })
    this.paused = false
    this.raceEnded = false
    this.config = config
    await this.unloadSession()
    await new Promise((r) => setTimeout(r, 30))
    try {
      const def = getTrackDefinition(config.trackId)
      gameStore.set({ loading: { progress: 0.15, label: `Building ${def.name}` } })
      await new Promise((r) => setTimeout(r, 16))
      this.track = await buildTrack(def, this.physics, this.textures, this.quality)
      this.scene.add(this.track.root)
      this.cameraRig.tracksideCameras = this.track.tracksideCameras
      gameStore.set({ loading: { progress: 0.55, label: 'Computing racing line' } })
      await new Promise((r) => setTimeout(r, 16))
      this.racingLine = new RacingLine(this.track.spline, this.track.halfWidth, 2.6, this.quality.propDensity >= 1 ? 140 : 90)

      // Environment.
      const env = def.environment
      this.sky.applyTheme(env)
      this.sky.hour = config.hour === 'default' ? env.defaultHour : config.hour
      this.sky.timeRate = config.timeRate / 60
      const weather: WeatherKind = config.weather === 'random' ? env.weatherOptions[Math.floor(Math.random() * env.weatherOptions.length)] : config.weather
      this.weather = new WeatherSystem(weather, env.weatherOptions, config.dynamicWeather, env.snow)
      this.scene.fog = this.sky.fog
      this.precipitation.setMode(this.weather.state.precipitation === 'snow' || env.snow ? 'snow' : 'rain', this.textures)

      // Licensed player models stream in here; a missing file falls back to
      // the procedural car inside buildCarVisual.
      const playerSpec = getVehicleSpec(config.carId)
      if (playerSpec.model) {
        gameStore.set({ loading: { progress: 0.62, label: `Loading ${playerSpec.name}` } })
        await modelLibrary.preload(playerSpec.model.file)
      }
      gameStore.set({ loading: { progress: 0.7, label: 'Assembling the grid' } })
      await new Promise((r) => setTimeout(r, 16))
      await this.spawnField(config)

      this.race = new RaceManager(this.track, config)
      this.vehicles.forEach((v, i) => this.race!.addRacer(v.id, v.name, v.spec.id, v.isPlayer, this.track!.startGrid[i]))
      this.replay.begin(this.vehicles.length)
      this.setupGhost(config)
      this.adaptiveSkill = 0.9
      this.raceStartTime = this.elapsed
      this.cameraRig.setMode(this.settings.gameplay.defaultCamera === 'cinematic' ? 'chase' : this.settings.gameplay.defaultCamera)
      this.cameraRig.fovBase = this.settings.graphics.fovBase
      this.cockpitWheel?.setDash(this.player?.spec.body.shape !== 'formula' && !this.player?.spec.model)
      this.post.setCamera(this.cameraRig.camera)
      this.scene.remove(this.showcase.root)
      this.mode = 'race'
      gameStore.set({ loading: { progress: 1, label: 'Lights out' }, hud: { ...initialHud(), totalLaps: this.race.totalLaps, total: this.vehicles.length, mode: config.mode, weather: this.weather.state.kind, seriesRound: this.seriesLabel() } })
      navigate('race')
      this.audio?.music.setMode('race')
      this.audio?.music.setIntensity(0.4)
      if (config.mode !== 'freeroam') this.race.startCountdown()
      else bus.emit('race:message', { text: 'OPEN DRIVING — EXPLORE FREELY', kind: 'info', ttl: 3 })
      log.info(`Race started: ${config.mode} @ ${def.name}, ${this.vehicles.length} cars`)
    } catch (err) {
      log.error('Failed to start race', err)
      pushToast('Could not start the session — see console', '⚠️')
      await this.quitToMenu()
    }
  }

  private async spawnField(config: RaceConfig): Promise<void> {
    const track = this.track!
    const profile = saveManager.get()
    ensureCarState(config.carId)
    const carState = profile.cars[config.carId]
    const playerSpec = getVehicleSpec(config.carId)
    const aiCount = clamp(config.aiCount, 0, Math.min(13, GAME_MODES[config.mode].aiMax))
    const total = aiCount + 1
    const playerSlot = config.playerGridSlot ?? (config.mode === 'timetrial' || config.mode === 'freeroam' || config.mode === 'drift' ? 0 : Math.min(total - 1, Math.max(0, Math.round(total * 0.6))))
    const assists = { abs: this.settings.controls.abs, tcs: this.settings.controls.tractionControl, esc: this.settings.controls.stabilityControl, autoTransmission: this.settings.controls.transmission === 'auto' }
    const fuelEnabled = this.settings.gameplay.fuelConsumption && config.mode === 'endurance'
    const damageEnabled = this.settings.gameplay.damage !== 'off'
    this.aiProfiles = generateField(aiCount, config.aiMix, config.seed)
    const usedCars = new Set<string>()
    let id = 0
    for (let slot = 0; slot < total; slot++) {
      const grid = track.startGrid[slot]
      if (slot === playerSlot) {
        const v = new Vehicle({
          id: id++,
          spec: playerSpec,
          customization: carState.customization,
          upgrades: carState.upgrades,
          isPlayer: true,
          name: profile.playerName,
          color: '#ff6a00',
          position: grid.position,
          quaternion: grid.quaternion,
          highDetail: true,
          physics: this.physics,
          scene: this.scene,
          textures: this.textures,
          audio: this.audio,
          assists,
          fuelEnabled,
          damageEnabled,
          initialDamage: config.mode === 'freeroam' ? 0 : carState.damage * 0.5,
        })
        this.vehicles.push(v)
        this.player = v
        continue
      }
      const aiIdx = this.vehicles.length - (this.player ? 1 : 0)
      const driver = this.aiProfiles[aiIdx] ?? this.aiProfiles[0]
      // A formula player races a spec-series field of other formula cars, and
      // road cars never draw formula traffic. Licensed models stay with the
      // player (the procedural team cars keep the field varied). Otherwise
      // assign a car of similar performance, preferring the driver's favourite.
      const formulaField = playerSpec.vehicleClass === 'formula'
      const pool = VEHICLE_CATALOG.filter((c) => !c.model && (formulaField ? c.vehicleClass === 'formula' : c.vehicleClass !== 'formula' && Math.abs(c.tier - playerSpec.tier) <= 1))
      let spec = pool.find((c) => c.id === driver.favouriteCar && !usedCars.has(c.id)) ?? pool[Math.floor(Math.random() * pool.length)]
      if (usedCars.size >= pool.length) spec = pool[Math.floor(Math.random() * pool.length)]
      usedCars.add(spec.id)
      const custom = defaultCustomization(spec)
      // Formula AI liveries come from the invented team table (two cars per
      // team) so the field is readable from behind; road cars keep the
      // driver-coloured random liveries.
      const team = formulaField ? FORMULA_TEAMS[Math.floor(aiIdx / 2) % FORMULA_TEAMS.length] : null
      if (team) {
        custom.paint = team.paint
        custom.accent = team.accent
        custom.livery = team.livery
        custom.liveryColor = team.liveryColor
        custom.raceNumber = 2 + ((aiIdx * 11) % 97)
      } else {
        custom.paint = driver.color
        custom.livery = (['racing', 'stripes', 'hex', 'none', 'splash'] as const)[Math.floor(Math.random() * 5)]
        custom.liveryColor = '#ffffff'
        custom.raceNumber = 2 + Math.floor(Math.random() * 97)
      }
      custom.plate = driver.name.split(' ')[0].toUpperCase().slice(0, 7)
      const upgrades = defaultUpgrades()
      const lvl = Math.round(driver.skill * 3)
      for (const k of Object.keys(upgrades) as (keyof typeof upgrades)[]) upgrades[k] = lvl
      const v = new Vehicle({
        id: id++,
        spec,
        customization: custom,
        upgrades,
        isPlayer: false,
        name: driver.name,
        color: team ? team.paint : driver.color,
        position: grid.position,
        quaternion: grid.quaternion,
        highDetail: this.quality.propDensity >= 0.7,
        physics: this.physics,
        scene: this.scene,
        textures: this.textures,
        audio: this.audio,
        assists: { abs: true, tcs: true, esc: true, autoTransmission: true },
        fuelEnabled,
        damageEnabled,
      })
      v.ai = new AIDriver(v.controller, this.racingLine!, driver, track.spline.nearestIndex(grid.position))
      this.vehicles.push(v)
      if (this.vehicles.length % 4 === 0) await new Promise((r) => setTimeout(r, 0))
    }
  }

  private setupGhost(config: RaceConfig): void {
    this.ghost = null
    if (this.ghostVisual) {
      this.scene.remove(this.ghostVisual.root)
      this.ghostVisual.dispose()
      this.ghostVisual = null
    }
    if (!config.ghost || !this.settings.gameplay.showGhost || config.mode !== 'timetrial') return
    const g = saveManager.get().ghosts[config.trackId]
    if (!g) return
    this.ghost = new GhostPlayer(g.samples, g.sampleRate, g.lapTime)
    const spec = getVehicleSpec(g.carId)
    const custom = defaultCustomization(spec)
    custom.paint = '#7ef0ff'
    custom.finish = 'gloss'
    this.ghostVisual = buildCarVisual(spec, custom, this.textures, false)
    this.ghostVisual.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) {
          const mm = m as THREE.MeshStandardMaterial
          mm.transparent = true
          mm.opacity = 0.35
          mm.depthWrite = false
        }
        o.castShadow = false
      }
    })
    this.scene.add(this.ghostVisual.root)
  }

  async restartRace(): Promise<void> {
    if (!this.config) return
    await this.startRace({ ...this.config, seed: this.config.seed + 1 })
  }

  async quitToMenu(): Promise<void> {
    const wasRacing = this.mode === 'race' && this.race && this.race.phase === 'racing'
    if (wasRacing) {
      this.race!.abort()
    }
    this.paused = false
    await this.unloadSession()
    this.enterShowcase(saveManager.get().selectedCar)
    gameStore.set({ paused: false, replay: { active: false, playing: false, time: 0, duration: 0, speed: 1 }, photo: { active: false, lastCapture: null } })
    navigate('menu')
  }

  /** End the race immediately and go to results. */
  finishRaceEarly(): void {
    if (this.race && this.race.phase !== 'finished') {
      this.paused = false
      gameStore.set({ paused: false })
      this.race.abort()
    }
  }

  private async unloadSession(): Promise<void> {
    for (const v of this.vehicles) v.dispose()
    this.vehicles = []
    this.player = null
    this.race = null
    this.racingLine = null
    if (this.ghostVisual) {
      this.scene.remove(this.ghostVisual.root)
      this.ghostVisual.dispose()
      this.ghostVisual = null
    }
    this.ghost = null
    if (this.track) {
      this.scene.remove(this.track.root)
      this.track.dispose()
      this.track = null
    }
    for (const l of this.lightPool) l.visible = false
    this.precipitation.setIntensity(0)
    this.textures.releaseUnused(0)
    this.mode = 'showcase'
  }

  private onRaceComplete(results: RaceResultSummary): void {
    if (this.raceEnded || !this.config || !this.player || !this.race) return
    this.raceEnded = true
    const config = this.config
    const player = this.player
    const wet = this.weather.state.wetness > 0.4
    const night = this.sky.nightFactor > 0.5
    const lapsDone = this.race.player?.lap ?? 0
    const distanceKm = player.distanceM / 1000
    const positionScoring = GAME_MODES[config.mode].scoring === 'position'
    // Leaderboards / records.
    let pb = false
    if (isFinite(results.playerBestLap) && results.playerBestLap > 10) {
      const sub = leaderboards.submit(config.trackId, 'lap', results.playerBestLap, config.carId)
      pb = sub.personalBest
      // Save ghost from the best lap.
      const r = this.race.player
      if (pb && r && r.lapTimes.length) {
        const bestIdx = r.lapTimes.indexOf(r.bestLap)
        const lapStart = r.lapTimes.slice(0, bestIdx).reduce((a, b) => a + b, 0)
        const samples = this.replay.extractGhost(player.id, lapStart, lapStart + r.bestLap)
        void network.ghosts.save({ id: '', trackId: config.trackId, carId: config.carId, playerName: saveManager.get().playerName, lapTime: r.bestLap, sampleRate: REPLAY_RATE, samples })
      }
    }
    if (results.driftScore > 0) leaderboards.submit(config.trackId, 'drift', results.driftScore, config.carId)
    results.isPersonalBest = pb
    const rewards = config.mode === 'freeroam' ? null : applyRaceRewards(results, config, wet, player.topSpeedKmh, distanceKm, this.race.player?.overtakes ?? 0, player.crashCount, lapsDone)
    if (rewards) {
      results.credits = rewards.totalCredits
      results.xp = rewards.xp
    }
    // Rating.
    if (positionScoring && this.aiProfiles.length) {
      void network.ratings.report(results.playerPosition, this.vehicles.length, this.aiProfiles.map((d) => Math.round(900 + d.skill * 1100)))
    }
    // Career stars.
    let stars = 0
    if (config.eventId) {
      const ref = getTrackDefinition(config.trackId).bestLapReference
      stars = starsForResult(config.mode, results.playerPosition, results.driftScore, results.playerBestLap, ref)
      if (!this.series || this.series.finished) recordCareerResult(config.eventId, stars)
    }
    const achievements = evaluateAchievements({ result: results, wet, night, topSpeedKmh: player.topSpeedKmh, crashes: player.crashCount, overtakes: this.race.player?.overtakes ?? 0, mode: config.mode, damage: player.controller.getDamage(), aiCount: config.aiCount, difficulty: config.difficulty })
    const challenges = applyChallengeResult(results, { trackId: config.trackId, carId: config.carId, laps: lapsDone, topSpeedKmh: player.topSpeedKmh, damage: player.controller.getDamage(), overtakes: this.race.player?.overtakes ?? 0, wet, positionScoring })
    saveManager.update((p) => {
      p.stats.timePlayedSec += this.elapsed - this.raceStartTime
    })
    // Series bookkeeping.
    if (this.series && !this.series.finished) this.advanceSeries(results)
    gameStore.set({ results, rewards, resultStars: stars, unlockedAchievements: achievements, completedChallenges: challenges, series: this.series ? { ...this.series } : null })
    this.audio?.music.setMode('results')
    this.cameraRig.setMode('cinematic')
    window.setTimeout(() => navigate('results'), config.mode === 'freeroam' ? 0 : 1800)
    bumpProfile()
  }

  // ---------------------------------------------------------------------------
  // Series (championship / knockout)
  // ---------------------------------------------------------------------------

  async startSeries(config: RaceConfig, kind: 'championship' | 'knockout'): Promise<void> {
    const unlocked = saveManager.get().unlockedTracks
    let tracks: string[]
    if (config.eventId && SERIES_TRACKS[config.eventId]) tracks = SERIES_TRACKS[config.eventId]
    else if (kind === 'championship') {
      const pool = TRACK_CATALOG.filter((t) => unlocked.includes(t.id) && t.id !== config.trackId).map((t) => t.id)
      tracks = [config.trackId, ...pool.sort(() => Math.random() - 0.5).slice(0, 3)]
      while (tracks.length < 4) tracks.push(config.trackId)
    } else tracks = [config.trackId, config.trackId, config.trackId]
    this.series = createSeries(kind, tracks)
    gameStore.set({ series: { ...this.series } })
    await this.startRace({ ...config, trackId: tracks[0], seriesRound: 1, seriesTotal: tracks.length, heat: kind === 'knockout' ? 1 : undefined })
  }

  private advanceSeries(results: RaceResultSummary): void {
    const s = this.series!
    for (const e of results.entries) s.names[e.name] = e.name
    if (s.kind === 'championship') {
      for (const e of results.entries) s.points[e.name] = (s.points[e.name] ?? 0) + (SERIES_POINTS[e.position - 1] ?? 0)
    } else {
      // Knockout: bottom half eliminated.
      const alive = results.entries.filter((e) => !s.eliminated.includes(e.name))
      const cut = Math.max(2, Math.ceil(alive.length / 2))
      for (const e of alive) if (e.position > cut) s.eliminated.push(e.name)
      const playerOut = s.eliminated.includes(results.entries.find((e) => e.isPlayer)?.name ?? '')
      if (playerOut) s.finished = true
    }
    s.round++
    if (s.round >= s.rounds.length) s.finished = true
    if (s.finished && this.config?.eventId) {
      // Career stars for the series = standing at the end.
      const standings = this.seriesStandings()
      const playerName = saveManager.get().playerName
      const pos = standings.findIndex((x) => x.name === playerName) + 1
      recordCareerResult(this.config.eventId, pos === 1 ? 3 : pos <= 3 ? 2 : pos <= 6 ? 1 : 0)
    }
  }

  seriesStandings(): { name: string; points: number; eliminated: boolean }[] {
    const s = this.series
    if (!s) return []
    const names = Object.keys(s.names)
    return names.map((n) => ({ name: n, points: s.points[n] ?? 0, eliminated: s.eliminated.includes(n) })).sort((a, b) => Number(a.eliminated) - Number(b.eliminated) || b.points - a.points)
  }

  async continueSeries(): Promise<void> {
    const s = this.series
    if (!s || s.finished || !this.config) return
    const heatAi = s.kind === 'knockout' ? Math.max(1, this.vehicles.length - 1 - s.eliminated.length) : this.config.aiCount
    await this.startRace({ ...this.config, trackId: s.rounds[s.round], seriesRound: s.round + 1, seriesTotal: s.rounds.length, heat: s.kind === 'knockout' ? s.round + 1 : undefined, aiCount: s.kind === 'knockout' ? Math.min(13, heatAi) : this.config.aiCount, seed: this.config.seed + s.round * 17 })
  }

  endSeries(): void {
    this.series = null
    gameStore.set({ series: null })
  }

  private seriesLabel(): string {
    if (!this.series) return ''
    const s = this.series
    return s.kind === 'knockout' ? (s.round + 1 >= s.rounds.length ? 'FINAL' : `HEAT ${s.round + 1}`) : `ROUND ${s.round + 1} / ${s.rounds.length}`
  }

  // ---------------------------------------------------------------------------
  // In-race controls
  // ---------------------------------------------------------------------------

  togglePause(): void {
    if (this.mode !== 'race' || !this.race || this.race.phase === 'finished') return
    this.paused = !this.paused
    gameStore.set({ paused: this.paused })
    this.input.setEnabled(!this.paused)
    this.audio?.music.setIntensity(this.paused ? 0.15 : 0.5)
    this.audio?.playUI(this.paused ? 'back' : 'click')
  }

  resume(): void {
    if (this.paused) this.togglePause()
  }

  setCamera(mode: CameraMode): void {
    this.cameraRig.setMode(mode)
    gameStore.set((s) => ({ hud: { ...s.hud, cameraMode: mode } }))
  }

  cycleCamera(): void {
    this.cameraRig.cycle()
    gameStore.set((s) => ({ hud: { ...s.hud, cameraMode: this.cameraRig.mode } }))
  }

  /** Attach or detach an AI brain to the player's car. */
  setAutopilot(on: boolean): void {
    this.autopilot = on
    if (!this.player || !this.racingLine || !this.track) return
    if (on && !this.player.ai) {
      const profile = generateField(1, 'pro', 7)[0]
      this.player.ai = new AIDriver(this.player.controller, this.racingLine, profile, this.track.spline.nearestIndex(this.player.position))
    } else if (!on) this.player.ai = null
  }

  respawnPlayer(): void {
    if (!this.player || !this.race) return
    const pose = this.race.respawnPose(this.player.id)
    this.player.respawn(pose.position, pose.quaternion)
  }

  /** Pause-menu repair (costs credits, only outside endurance pit rules). */
  repairPlayerNow(): boolean {
    if (!this.player) return false
    const cost = Math.round(this.player.controller.getDamage() * 2500 + 250)
    const p = saveManager.get()
    if (p.credits < cost) return false
    saveManager.update((pp) => {
      pp.credits -= cost
    })
    this.player.controller.repair(1)
    this.player.controller.refuel()
    pushToast(`Repaired for ${cost} CR`, '🔧')
    bumpProfile()
    return true
  }

  enterPhotoMode(): void {
    if (this.mode !== 'race' && this.mode !== 'replay') return
    this.paused = true
    this.input.setEnabled(false)
    this.cameraRig.setMode('photo')
    gameStore.set((s) => ({ photo: { ...s.photo, active: true }, hudVisible: false }))
  }

  exitPhotoMode(): void {
    if (!gameStore.get().photo.active) return
    this.cameraRig.setMode(this.settings.gameplay.defaultCamera === 'cinematic' ? 'chase' : this.settings.gameplay.defaultCamera)
    if (this.mode === 'race' && !gameStore.get().paused) {
      this.paused = false
      this.input.setEnabled(true)
    }
    gameStore.set((s) => ({ photo: { ...s.photo, active: false }, hudVisible: true }))
  }

  capturePhoto(): string {
    this.renderFrame(0)
    const url = captureFrame(this.canvas)
    storePhoto(url)
    gameStore.set((s) => ({ photo: { ...s.photo, lastCapture: url } }))
    this.post.triggerFlash(0.6)
    this.audio?.playUI('click')
    bumpProfile()
    return url
  }

  photoCameraFov(delta: number): void {
    this.cameraRig.photoFov(delta)
  }

  startReplay(): void {
    if (!this.race || this.replay.frameCount < 10) return
    this.mode = 'replay'
    this.replayTime = 0
    this.replayPlaying = true
    this.replaySpeed = 1
    this.input.setEnabled(false)
    this.cameraRig.setMode('replay')
    gameStore.set({ replay: { active: true, playing: true, time: 0, duration: this.replay.length, speed: 1 }, hudVisible: false })
  }

  stopReplay(): void {
    if (this.mode !== 'replay') return
    this.mode = 'race'
    this.replayPlaying = false
    this.cameraRig.setMode('cinematic')
    gameStore.set({ replay: { active: false, playing: false, time: 0, duration: 0, speed: 1 }, hudVisible: true })
    // Restore live transforms.
    for (const v of this.vehicles) {
      v.visual.root.position.copy(v.controller.position)
      v.visual.root.quaternion.copy(v.controller.quaternion)
    }
  }

  setReplayPlaying(playing: boolean): void {
    this.replayPlaying = playing
    gameStore.set((s) => ({ replay: { ...s.replay, playing } }))
  }

  setReplaySpeed(speed: number): void {
    this.replaySpeed = speed
    gameStore.set((s) => ({ replay: { ...s.replay, speed } }))
  }

  seekReplay(t: number): void {
    this.replayTime = clamp(t, 0, this.replay.length)
    gameStore.set((s) => ({ replay: { ...s.replay, time: this.replayTime } }))
  }

  // ---------------------------------------------------------------------------
  // Contact events
  // ---------------------------------------------------------------------------

  private onContact(m1: { vehicleId?: number; wall?: boolean } | undefined, m2: { vehicleId?: number; wall?: boolean } | undefined, c1: number, c2: number, force: number): void {
    if (!this.track) return
    void c1
    void c2
    const v1 = m1?.vehicleId !== undefined ? this.vehicles[m1.vehicleId] : null
    const v2 = m2?.vehicleId !== undefined ? this.vehicles[m2.vehicleId] : null
    if (!v1 && !v2) return
    const a = v1 ?? v2!
    const b = v1 && v2 ? (a === v1 ? v2 : v1) : null
    // Approximate contact point & normal from body positions.
    const point = new THREE.Vector3()
    const normal = new THREE.Vector3()
    if (b) {
      point.copy(a.position).add(b.position).multiplyScalar(0.5)
      normal.copy(a.position).sub(b.position).normalize()
    } else {
      point.copy(a.position).addScaledVector(a.controller.forward, a.spec.body.length * 0.45)
      normal.copy(a.controller.forward).multiplyScalar(-1)
      // Use velocity direction as a better guess for wall hits.
      if (a.controller.velocity.lengthSq() > 4) {
        const dir = a.controller.velocity.clone().normalize()
        point.copy(a.position).addScaledVector(dir, a.spec.body.length * 0.45)
        normal.copy(dir).multiplyScalar(-1)
      }
    }
    const sev = a.onCollision(force, point, normal, b ? b.id : null, this.particles, this.audio, this.elapsed)
    if (b) b.onCollision(force, point, normal.clone().multiplyScalar(-1), a.id, this.particles, this.audio, this.elapsed)
    if (sev > 0 && (a.isPlayer || b?.isPlayer)) {
      this.cameraRig.shake(sev * 1.2)
      if (sev > 0.35) this.post.triggerFlash(sev * 0.12)
      if (this.settings.controls.vibration && navigator.vibrate) navigator.vibrate(Math.round(sev * 120))
    }
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  private loop = (now: number): void => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.loop)
    const rawDt = (now - this.lastTime) / 1000
    this.lastTime = now
    const dt = Math.min(rawDt, 0.1)
    this.elapsed += dt
    this.frameCounter++
    this.qualityManager.update(rawDt * 1000)
    this.textures.tick()
    try {
      if (this.mode === 'showcase' || this.mode === 'loading') this.updateShowcase(dt)
      else if (this.mode === 'race') this.updateRace(dt)
      else if (this.mode === 'replay') this.updateReplay(dt)
      this.renderFrame(dt)
    } catch (err) {
      log.error('Frame error', err)
      bus.emit('engine:error', { message: err instanceof Error ? err.message : String(err), fatal: false })
    }
    if (this.audio && !gameStore.get().audioUnlocked && this.audio.isUnlocked) gameStore.set({ audioUnlocked: true })
  }

  private updateShowcase(dt: number): void {
    this.cockpitWheel?.setVisible(false)
    const input = this.input.update(dt)
    const dragging = Math.abs(input.cameraOrbitX) > 0.0005
    this.showcase.autoRotate = !dragging
    this.showcase.update(dt, input.cameraOrbitX + this.showcaseDrag)
    this.showcaseDrag = damp(this.showcaseDrag, 0, 6, dt)
    const t = this.elapsed * 0.08
    this.showcaseCamera.position.set(Math.sin(t) * 1.2 + 7.2, 2.3 + Math.sin(t * 0.7) * 0.25, Math.cos(t * 0.9) * 1.2 + 7.2)
    this.showcaseCamera.lookAt(this.showcase.cameraTarget)
    this.scene.environmentIntensity = 0.7 * this.sky.envBoost
    // Studio spotlights push HDR values far past the bloom threshold and the
    // pass would smear the car into a blur, so bloom stays off in the garage.
    this.post.bloomScale = 0
    this.post.setEnvironment(0.6, 0, 0, 'cool')
    this.post.setSpeed(0, false)
    this.particles.update(dt)
    if (this.audio) this.audio.updateListener(this.showcaseCamera, dt)
  }

  private updateRace(dt: number): void {
    const race = this.race!
    const track = this.track!
    const player = this.player!
    const photoActive = gameStore.get().photo.active
    const input = this.input.update(dt)
    const simDt = this.paused ? 0 : dt

    if (!this.paused) {
      // Player input.
      if (race.active && !this.autopilot) {
        player.input.steer = input.steer
        player.input.throttle = input.throttle
        player.input.brake = input.brake
        player.input.handbrake = input.handbrake
        player.input.boost = input.boost
      } else if (!this.autopilot) {
        // Hold the car on the grid with the handbrake (never the brake — that engages reverse).
        player.input.throttle = 0
        player.input.brake = 0
        player.input.steer = input.steer
        player.input.handbrake = race.phase === 'countdown' || race.phase === 'grid'
        player.input.boost = false
      }
      this.cameraRig.lookBack = input.lookBack

      // AI.
      const traffic: AITrafficEntry[] = this.vehicles.map((v) => {
        const r = race.racers.get(v.id)
        return { id: v.id, position: v.position, velocity: v.controller.velocity, progress: r?.progress ?? 0, lateral: 0, isPlayer: v.isPlayer, finished: r?.finished || r?.eliminated || false }
      })
      for (const t of traffic) {
        const v = this.vehicles[t.id]
        t.lateral = v.ai ? v.ai.lateral : track.spline.lateralOffset(v.position, race.racers.get(v.id)?.splineIndex ?? 0)
      }
      const difficulty = this.config!.difficulty
      if (difficulty === 'adaptive' && race.phase === 'racing') {
        const p = race.player
        const target = p ? clamp(0.75 + ((p.position - 1) / Math.max(1, this.vehicles.length - 1)) * -0.3 + 0.2, 0.7, 1.05) : 0.9
        this.adaptiveSkill = damp(this.adaptiveSkill, target, 0.05, simDt)
      }
      const ctx: AIContext = {
        traffic,
        playerProgress: race.player?.progress ?? 0,
        trackLength: track.spline.length,
        raceActive: race.active,
        wetness: this.weather.state.wetness,
        snow: this.weather.state.snowCover,
        difficultyScale: difficulty === 'adaptive' ? this.adaptiveSkill : DIFFICULTY_SCALE[difficulty],
        catchUp: difficulty === 'legend' ? 0.3 : difficulty === 'adaptive' ? 1 : 0.7,
        closed: track.def.closed,
        raceTime: race.phase === 'racing' ? race.raceTime : 0,
      }
      for (const v of this.vehicles) {
        if (!v.ai) continue
        if (v.isPlayer && !this.autopilot) continue
        const r = race.racers.get(v.id)
        if (r?.finished || r?.eliminated) {
          v.input.throttle = 0
          v.input.brake = 0
          v.input.handbrake = true
          v.input.boost = false
          continue
        }
        const out = v.ai.update(simDt, ctx)
        v.input.steer = out.steer
        v.input.throttle = out.throttle
        v.input.brake = out.brake
        v.input.handbrake = out.handbrake
        v.input.boost = out.boost
      }

      // Physics.
      const grip = this.weather.gripState()
      for (const v of this.vehicles) v.controller.weather = grip
      this.physics.update(simDt, (stepDt) => {
        for (const v of this.vehicles) v.fixedUpdate(stepDt)
      })

      // Race logic.
      const observations = this.vehicles.map((v) => ({ id: v.id, position: v.position, forward: v.controller.forward, speedKmh: v.telemetry.speedKmh, driftScore: v.drift.total + Math.round(v.drift.state.current), damage: v.controller.getDamage() }))
      race.update(simDt, observations, (vehicleId, sdt) => {
        const v = this.vehicles[vehicleId]
        if (!v) return
        v.controller.repair(sdt * 0.25)
        v.controller.refuel(sdt * 12)
      })

      // Respawns.
      for (const v of this.vehicles) {
        if (v.controller.needsRespawn) {
          const pose = race.respawnPose(v.id)
          v.respawn(pose.position, pose.quaternion)
        }
      }

      // Weather + sky + environment.
      this.weather.update(simDt)
      const w = this.weather.state
      if (w.lightning > 0.8 && !this.lightningWasHigh) {
        this.lightningWasHigh = true
        this.post.triggerFlash(0.35)
        window.setTimeout(() => this.audio?.playThunder(), 400 + Math.random() * 1500)
      } else if (w.lightning < 0.3) this.lightningWasHigh = false
      this.precipitation.setMode(w.precipitation === 'snow' ? 'snow' : 'rain', this.textures)
      this.precipitation.setIntensity(w.precipitation === 'none' ? 0 : w.precipIntensity)
      this.particles.wind.set(w.windStrength * 3, 0, w.windStrength * 1.5)
      track.update(simDt, this.cameraRig.camera.position, this.quality.drawDistance, this.elapsed)
      track.setWeatherVisual(w.wetness, w.snowCover, this.sky.nightFactor)

      // Replay recording.
      if (race.phase === 'racing') this.replay.record(simDt, this.vehicles.map((v) => ({ position: v.controller.position, quaternion: v.controller.quaternion, steer: v.controller.telemetry.steerAngle })))
    }

    // Visual updates (interpolate at the current alpha even when paused).
    const alpha = this.paused ? 1 : this.physics.alpha
    const w = this.weather.state
    for (const v of this.vehicles) v.update(simDt, alpha, this.particles, w.wetness, w.snowCover, this.sky.nightFactor, this.cameraRig.camera.position, { engineVolume: 1 })

    // Ghost.
    if (this.ghost && this.ghostVisual && race.player) {
      const lapTime = race.raceTime - race.player.currentLapStart
      if (this.ghost.sample(lapTime, this.ghostVisual.root.position, this.ghostVisual.root.quaternion)) this.ghostVisual.root.visible = race.phase === 'racing'
    }

    const t = player.telemetry

    // Pit-lane limiter: engages automatically for anyone in the lane and
    // releases once the exit line (end of the pit zone) is passed.
    for (const v of this.vehicles) {
      const r = race.racers.get(v.id)
      v.controller.speedLimitKmh = r?.inPitLane ? 96.5 : null
    }
    // DRS: available inside a designated zone, active while flat out there.
    let drs: 'none' | 'available' | 'active' = 'none'
    const pr = race.player
    if (pr && !pr.inPitLane && track.drsZones.length && (race.phase === 'racing' || race.phase === 'freeroam')) {
      const inZone = track.drsZones.some((z) => (z.from <= z.to ? pr.progress > z.from && pr.progress < z.to : pr.progress > z.from || pr.progress < z.to))
      if (inZone) drs = t.speedKmh > 80 && player.input.throttle > 0.85 && player.input.brake < 0.1 && !t.airborne ? 'active' : 'available'
    }
    this.playerDrs = drs
    player.controller.drsActive = drs === 'active'

    // Camera.
    this.cameraRig.update(dt, {
      position: player.visual.root.position,
      quaternion: player.visual.root.quaternion,
      velocity: player.controller.velocity,
      forward: player.controller.forward,
      up: player.controller.up,
      speedKmh: t.speedKmh,
      gLat: t.gLat,
      gLong: t.gLong,
      boosting: t.nitroActive,
      bodyHeight: player.spec.body.height,
      bodyLength: player.spec.body.length,
      cockpitOffset: player.spec.model
        ? new THREE.Vector3(player.spec.model.cockpitEye[0], player.spec.model.cockpitEye[1] - player.spec.comHeight, player.spec.model.cockpitEye[2])
        : player.spec.body.shape === 'formula'
          ? new THREE.Vector3(0, 0.54, 0.02)
          : new THREE.Vector3(-0.35, player.spec.body.height * 0.55 - player.spec.comHeight + 0.35, player.spec.body.length * 0.05),
      hoodOffset: player.spec.model
        ? new THREE.Vector3(player.spec.model.tcam[0], player.spec.model.tcam[1] - player.spec.comHeight, player.spec.model.tcam[2])
        : player.spec.body.shape === 'formula' ? new THREE.Vector3(0, 1.02 - player.spec.comHeight, -0.3) : undefined,
    }, { x: input.cameraOrbitX, y: input.cameraOrbitY })

    // Procedural cars have no modelled interior, so in cockpit view their
    // shell and detail meshes are hidden (licensed models hide only their own
    // steering wheel) — otherwise the windshield glass slices
    // the view at eye level and washes out the display. The wheels stay
    // visible for an open-wheeler feel; headlight spots live on the root.
    for (const o of player.visual.cockpitHidden) o.visible = this.cameraRig.mode !== 'cockpit'
    this.cockpitWheel?.update(dt, this.cameraRig.mode === 'cockpit' ? {
      steerAngle: t.steerAngle,
      maxSteerAngle: THREE.MathUtils.degToRad(player.spec.steering.maxAngle),
      gear: t.gear,
      speedKmh: t.speedKmh,
      rpm: t.rpm,
      redline: player.tuned.engine.redline,
      limiter: t.limiter,
      units: this.settings.controls.units,
      ers: player.controller.getNitroFraction(),
      ersMode: t.nitroActive ? 'deploy' : t.harvesting ? 'harvest' : 'idle',
      drs: this.playerDrs,
      pitLimiter: race.player?.inPitLane ?? false,
    } : null)

    this.sky.update(simDt, w, player.position, this.cameraRig.camera.getWorldDirection(new THREE.Vector3()))
    this.updateStreetLights()
    this.particles.update(simDt)
    this.precipitation.update(dt, this.cameraRig.camera, this.cameraRig.velocity)
    this.post.setSpeed(clamp01(t.speedKmh / 320), t.nitroActive)
    this.post.bloomScale = 1
    this.post.setEnvironment(this.sky.nightFactor, w.wetness * (this.cameraRig.mode === 'cockpit' ? 1 : 0.3), player.controller.getDamage(), this.sky.hour > 16 && this.sky.hour < 20 ? 'warm' : this.sky.nightFactor > 0.5 ? 'cool' : 'neutral')

    // Audio.
    if (this.audio) {
      this.audio.updateListener(this.cameraRig.camera, dt)
      const inTunnel = track.tunnelZones.some((z) => (race.player?.progress ?? 0) > z.from && (race.player?.progress ?? 0) < z.to)
      let crowd = 0
      for (const z of track.crowdZones) {
        const d = z.position.distanceTo(player.position)
        crowd = Math.max(crowd, clamp01(1 - d / z.radius))
      }
      this.audio.setAmbience({ speedKmh: this.cameraRig.mode === 'cockpit' ? t.speedKmh * 0.6 : t.speedKmh, rain: w.precipitation === 'rain' ? w.precipIntensity : 0, crowd, tunnel: inTunnel ? 1 : 0, wind: w.windStrength })
      const p = race.player
      const finalLap = p ? p.lap >= race.totalLaps - 1 && p.lap >= 0 : false
      const battle = race.standings().some((r) => !r.isPlayer && Math.abs(r.totalProgress - (p?.totalProgress ?? 0)) < 30)
      this.audio.music.setIntensity(this.paused ? 0.15 : race.phase === 'racing' ? clamp01(0.35 + t.speedKmh / 400 + (finalLap ? 0.2 : 0) + (battle ? 0.15 : 0)) : 0.3)
    }

    // HUD (20 Hz).
    this.hudAccumulator += dt
    if (this.hudAccumulator >= 0.05 && !photoActive) {
      this.hudAccumulator = 0
      this.pushHud()
    }
  }

  private updateReplay(dt: number): void {
    this.cockpitWheel?.setVisible(false)
    if (this.player) for (const o of this.player.visual.cockpitHidden) o.visible = true
    if (this.replayPlaying) {
      this.replayTime += dt * this.replaySpeed
      if (this.replayTime >= this.replay.length) {
        this.replayTime = this.replay.length
        this.replayPlaying = false
        gameStore.set((s) => ({ replay: { ...s.replay, playing: false } }))
      }
    }
    const snap = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), steer: 0 }
    const prev = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), steer: 0 }
    for (const v of this.vehicles) {
      if (!this.replay.sample(v.id, this.replayTime, snap)) continue
      this.replay.sample(v.id, Math.max(0, this.replayTime - 0.05), prev)
      v.visual.root.position.copy(snap.position)
      v.visual.root.quaternion.copy(snap.quaternion)
      const vel = snap.position.clone().sub(prev.position).divideScalar(0.05)
      v.visual.wheels.forEach((hub, i) => {
        if (i < 2) hub.rotation.y = snap.steer
        v.visual.wheelSpin[i].rotation.x += (vel.length() / v.spec.body.wheelRadius) * dt * this.replaySpeed
      })
      v.visual.setLights(this.sky.nightFactor > 0.35, false, false)
      if (v.isPlayer) {
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(snap.quaternion)
        this.cameraRig.update(dt, {
          position: snap.position,
          quaternion: snap.quaternion,
          velocity: vel,
          forward: fwd,
          up: new THREE.Vector3(0, 1, 0).applyQuaternion(snap.quaternion),
          speedKmh: vel.length() * 3.6,
          gLat: 0,
          gLong: 0,
          boosting: false,
          bodyHeight: v.spec.body.height,
          bodyLength: v.spec.body.length,
          cockpitOffset: new THREE.Vector3(0, 0.6, 0),
        }, { x: 0, y: 0 })
        if (this.audio) {
          this.audio.updateListener(this.cameraRig.camera, dt)
          v.audio?.update({ rpm: 2000 + vel.length() * 80, throttle: 0.4, load: 0.4, boost: 0, nitro: false, limiter: false, redline: v.tuned.engine.redline }, 0, 'none', false, snap.position, vel)
        }
      }
    }
    this.sky.update(0, this.weather.state, this.cameraRig.camera.position, this.cameraRig.camera.getWorldDirection(new THREE.Vector3()))
    this.particles.update(dt)
    this.precipitation.update(dt, this.cameraRig.camera, this.cameraRig.velocity)
    this.post.setSpeed(0, false)
    if (this.frameCounter % 6 === 0) gameStore.set((s) => ({ replay: { ...s.replay, time: this.replayTime, duration: this.replay.length } }))
  }

  private updateStreetLights(): void {
    const track = this.track
    if (!track || this.sky.nightFactor < 0.4) {
      for (const l of this.lightPool) l.visible = false
      return
    }
    const lamps = track.props.lampPositions
    if (!lamps.length) return
    if (this.frameCounter % 10 !== 0) return
    const cam = this.cameraRig.camera.position
    const nearest = lamps
      .map((p) => ({ p, d: p.distanceToSquared(cam) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.lightPool.length)
    this.lightPool.forEach((l, i) => {
      const n = nearest[i]
      if (!n) {
        l.visible = false
        return
      }
      l.visible = true
      l.position.copy(n.p)
      l.intensity = 120 * this.sky.nightFactor
    })
  }

  private pushHud(): void {
    const race = this.race!
    const player = this.player!
    const t = player.telemetry
    const r = race.player
    const standings: HudStanding[] = race.standings().map((s) => ({ id: s.vehicleId, name: s.name, position: s.position, gap: s.gap, isPlayer: s.isPlayer, carId: s.carId, finished: s.finished, eliminated: s.eliminated, color: this.vehicles[s.vehicleId]?.color ?? '#fff', lap: s.lap }))
    const minimap: MinimapCar[] = this.vehicles.map((v) => ({ x: v.position.x, z: v.position.z, yaw: Math.atan2(v.controller.forward.x, v.controller.forward.z), isPlayer: v.isPlayer, color: v.color }))
    let ghostDelta: number | null = null
    if (this.ghost && r) ghostDelta = null
    gameStore.set({
      hud: {
        speedKmh: t.speedKmh,
        rpm: t.rpm,
        redline: player.tuned.engine.redline,
        gear: t.gear,
        position: r?.position ?? 1,
        total: this.vehicles.length,
        lap: Math.max(0, r?.lap ?? 0),
        totalLaps: race.totalLaps,
        lapTime: r ? race.raceTime - r.currentLapStart : 0,
        bestLap: r?.bestLap ?? Infinity,
        lastLap: r?.lapTimes[r.lapTimes.length - 1] ?? 0,
        raceTime: race.raceTime,
        nitro: player.controller.getNitroFraction(),
        boostActive: t.nitroActive,
        ersHarvest: t.harvesting,
        fuel: player.controller.getFuelFraction(),
        damage: player.controller.getDamage(),
        turbo: t.turboBoost,
        drifting: t.drifting,
        driftCurrent: Math.round(player.drift.state.current),
        driftMultiplier: player.drift.state.multiplier,
        driftBanked: player.drift.total,
        countdown: race.phase === 'countdown' ? race.countdown : 0,
        phase: race.phase,
        wrongWay: r?.wrongWay ?? false,
        standings,
        minimap,
        eliminationTimer: race.mode.eliminationInterval > 0 ? race.eliminationCountdown : 0,
        sectorTimes: r?.sectorTimes ?? [],
        weather: this.weather.state.kind,
        hour: this.sky.hour,
        fps: this.qualityManager.fps,
        inPit: r?.inPit ?? false,
        pitLimiter: r?.inPitLane ?? false,
        drs: this.playerDrs,
        cameraMode: this.cameraRig.mode,
        isNight: this.sky.nightFactor > 0.5,
        wetness: this.weather.state.wetness,
        gLat: t.gLat,
        gLong: t.gLong,
        ghostDelta,
        topSpeed: player.topSpeedKmh,
        mode: this.config?.mode ?? 'quick',
        seriesRound: this.seriesLabel(),
      },
    })
  }

  private renderFrame(dt: number): void {
    this.post.render(dt)
  }

  getMinimap() {
    return this.track?.minimap ?? null
  }

  get fps(): number {
    return this.qualityManager.fps
  }

  get profile() {
    return saveManager.get()
  }

  dispose(): void {
    this.running = false
    cancelAnimationFrame(this.rafId)
    for (const d of this.disposeListeners) d()
    void this.unloadSession()
    this.cockpitWheel?.dispose()
    this.showcase.dispose()
    this.particles.dispose()
    this.precipitation.dispose()
    this.sky.dispose()
    modelLibrary.dispose()
    this.post.dispose()
    this.audio?.dispose()
    this.textures.dispose()
    this.physics.dispose()
    this.renderer.dispose()
    window.removeEventListener('resize', this.onResize)
    Engine._instance = null
  }
}

export const lerpHud = lerp
