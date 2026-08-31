/**
 * Web Audio front-end: mixer buses, 3D listener, per-vehicle engine and skid
 * voices (positional), one-shot effects (impacts, gear shifts, blow-off,
 * nitrous, UI), environmental ambience (wind, rain, crowd, tunnel reverb) and
 * the adaptive music system. Everything is synthesised — no audio files.
 */

import * as THREE from 'three'
import type { AudioSettings } from '../core/Settings'
import type { VehicleSpec } from '../vehicles/VehicleSpec'
import { EngineVoice, type EngineVoiceParams } from './EngineSynth'
import { MusicSystem } from './MusicSystem'
import { Logger } from '../core/Logger'
import { clamp01 } from '../core/MathUtils'

const log = Logger.scope('Audio')

export interface VehicleAudioHandle {
  engine: EngineVoice
  panner: PannerNode
  skidGain: GainNode
  skidFilter: BiquadFilterNode
  nitroGain: GainNode
  position: THREE.Vector3
  active: boolean
  update(engine: EngineVoiceParams, skid: number, skidKind: 'tarmac' | 'gravel' | 'snow' | 'none', nitro: boolean, position: THREE.Vector3, velocity: THREE.Vector3): void
  dispose(): void
}

export class AudioEngine {
  readonly ctx: AudioContext
  readonly master: GainNode
  readonly engineBus: GainNode
  readonly sfxBus: GainNode
  readonly ambienceBus: GainNode
  readonly musicBus: GainNode
  readonly music: MusicSystem
  private readonly noiseBuffer: AudioBuffer
  private readonly windGain: GainNode
  private readonly windFilter: BiquadFilterNode
  private readonly rainGain: GainNode
  private readonly crowdGain: GainNode
  private readonly reverb: ConvolverNode
  private readonly reverbSend: GainNode
  private readonly compressor: DynamicsCompressorNode
  private unlocked = false
  private settings: AudioSettings
  private readonly listenerPos = new THREE.Vector3()
  private readonly voices = new Set<VehicleAudioHandle>()
  private uiCooldown = 0

  constructor(settings: AudioSettings) {
    this.settings = settings
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new Ctor({ latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.compressor = this.ctx.createDynamicsCompressor()
    this.compressor.threshold.value = -12
    this.compressor.ratio.value = 4
    this.master.connect(this.compressor).connect(this.ctx.destination)
    this.engineBus = this.ctx.createGain()
    this.sfxBus = this.ctx.createGain()
    this.ambienceBus = this.ctx.createGain()
    this.musicBus = this.ctx.createGain()
    for (const b of [this.engineBus, this.sfxBus, this.ambienceBus, this.musicBus]) b.connect(this.master)

    this.noiseBuffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate)
    const d = this.noiseBuffer.getChannelData(0)
    let last = 0
    for (let i = 0; i < d.length; i++) {
      // Pink-ish noise via simple low-pass of white noise.
      const white = Math.random() * 2 - 1
      last = last * 0.96 + white * 0.04
      d[i] = last * 4 + white * 0.25
    }

    // Reverb (tunnel) — synthesized impulse.
    this.reverb = this.ctx.createConvolver()
    this.reverb.buffer = this.makeImpulse(1.8, 2.5)
    this.reverbSend = this.ctx.createGain()
    this.reverbSend.gain.value = 0
    this.reverbSend.connect(this.reverb).connect(this.master)
    this.engineBus.connect(this.reverbSend)
    this.sfxBus.connect(this.reverbSend)

    // Ambience loops.
    const wind = this.ctx.createBufferSource()
    wind.buffer = this.noiseBuffer
    wind.loop = true
    this.windFilter = this.ctx.createBiquadFilter()
    this.windFilter.type = 'lowpass'
    this.windFilter.frequency.value = 300
    this.windGain = this.ctx.createGain()
    this.windGain.gain.value = 0
    wind.connect(this.windFilter).connect(this.windGain).connect(this.ambienceBus)
    wind.start()
    const rain = this.ctx.createBufferSource()
    rain.buffer = this.noiseBuffer
    rain.loop = true
    const rainFilter = this.ctx.createBiquadFilter()
    rainFilter.type = 'highpass'
    rainFilter.frequency.value = 2500
    this.rainGain = this.ctx.createGain()
    this.rainGain.gain.value = 0
    rain.connect(rainFilter).connect(this.rainGain).connect(this.ambienceBus)
    rain.start()
    const crowd = this.ctx.createBufferSource()
    crowd.buffer = this.noiseBuffer
    crowd.loop = true
    crowd.playbackRate.value = 0.5
    const crowdFilter = this.ctx.createBiquadFilter()
    crowdFilter.type = 'bandpass'
    crowdFilter.frequency.value = 900
    crowdFilter.Q.value = 0.5
    this.crowdGain = this.ctx.createGain()
    this.crowdGain.gain.value = 0
    crowd.connect(crowdFilter).connect(this.crowdGain).connect(this.ambienceBus)
    crowd.start()

    this.music = new MusicSystem(this.ctx)
    this.music.output.connect(this.musicBus)
    this.applySettings(settings)

    const unlock = () => void this.resume()
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock)
    window.addEventListener('touchstart', unlock, { passive: true })
    document.addEventListener('visibilitychange', () => {
      if (!this.settings.muteInBackground) return
      if (document.visibilityState === 'hidden') this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05)
      else this.master.gain.setTargetAtTime(this.settings.master, this.ctx.currentTime, 0.2)
    })
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate
    const len = rate * seconds
    const buf = this.ctx.createBuffer(2, len, rate)
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c)
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
    }
    return buf
  }

  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume()
      } catch (err) {
        log.warn('AudioContext resume failed', err)
        return
      }
    }
    if (!this.unlocked) {
      this.unlocked = true
      for (const v of this.voices) v.engine.start()
      log.info('Audio unlocked')
    }
  }

  get isUnlocked(): boolean {
    return this.unlocked
  }

  applySettings(s: AudioSettings): void {
    this.settings = s
    const t = this.ctx.currentTime
    this.master.gain.setTargetAtTime(s.master, t, 0.1)
    this.engineBus.gain.setTargetAtTime(s.engine * 0.8, t, 0.1)
    this.sfxBus.gain.setTargetAtTime(s.sfx, t, 0.1)
    this.ambienceBus.gain.setTargetAtTime(s.ambience, t, 0.1)
    this.musicBus.gain.setTargetAtTime(s.music, t, 0.1)
  }

  updateListener(camera: THREE.Camera, dt: number): void {
    const l = this.ctx.listener
    const p = camera.getWorldPosition(this.listenerPos)
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
    const t = this.ctx.currentTime
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02)
      l.positionY.setTargetAtTime(p.y, t, 0.02)
      l.positionZ.setTargetAtTime(p.z, t, 0.02)
      l.forwardX.setTargetAtTime(fwd.x, t, 0.02)
      l.forwardY.setTargetAtTime(fwd.y, t, 0.02)
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.02)
      l.upX.setTargetAtTime(up.x, t, 0.02)
      l.upY.setTargetAtTime(up.y, t, 0.02)
      l.upZ.setTargetAtTime(up.z, t, 0.02)
    } else {
      l.setPosition(p.x, p.y, p.z)
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z)
    }
    this.uiCooldown = Math.max(0, this.uiCooldown - dt)
  }

  createVehicleVoice(spec: VehicleSpec, isPlayer: boolean): VehicleAudioHandle {
    const ctx = this.ctx
    const panner = ctx.createPanner()
    panner.panningModel = 'equalpower'
    panner.distanceModel = 'inverse'
    panner.refDistance = isPlayer ? 6 : 4
    panner.maxDistance = 300
    panner.rolloffFactor = isPlayer ? 0.6 : 1.4
    panner.connect(this.engineBus)
    const engine = new EngineVoice(ctx, spec, this.noiseBuffer)
    engine.output.connect(panner)
    if (this.unlocked) engine.start()

    const skid = ctx.createBufferSource()
    skid.buffer = this.noiseBuffer
    skid.loop = true
    const skidFilter = ctx.createBiquadFilter()
    skidFilter.type = 'bandpass'
    skidFilter.frequency.value = 1400
    skidFilter.Q.value = 1.2
    const skidGain = ctx.createGain()
    skidGain.gain.value = 0
    skid.connect(skidFilter).connect(skidGain).connect(panner)
    skid.start()

    const nitro = ctx.createBufferSource()
    nitro.buffer = this.noiseBuffer
    nitro.loop = true
    nitro.playbackRate.value = 1.6
    const nitroFilter = ctx.createBiquadFilter()
    nitroFilter.type = 'bandpass'
    nitroFilter.frequency.value = 3200
    const nitroGain = ctx.createGain()
    nitroGain.gain.value = 0
    nitro.connect(nitroFilter).connect(nitroGain).connect(panner)
    nitro.start()

    const listenerPos = this.listenerPos
    const voices = this.voices
    const handle: VehicleAudioHandle = {
      engine,
      panner,
      skidGain,
      skidFilter,
      nitroGain,
      position: new THREE.Vector3(),
      active: true,
      update: (params, skidAmount, skidKind, nitroOn, position, velocity) => {
        const t = ctx.currentTime
        handle.position.copy(position)
        const dist = position.distanceTo(listenerPos)
        const shouldBeActive = isPlayer || dist < 140
        if (shouldBeActive !== handle.active) {
          handle.active = shouldBeActive
          engine.setActive(shouldBeActive)
        }
        if (!shouldBeActive) return
        if (panner.positionX) {
          panner.positionX.setTargetAtTime(position.x, t, 0.03)
          panner.positionY.setTargetAtTime(position.y, t, 0.03)
          panner.positionZ.setTargetAtTime(position.z, t, 0.03)
        } else panner.setPosition(position.x, position.y, position.z)
        void velocity
        engine.update(params, isPlayer ? 1 : 0.7)
        const skidVol = skidKind === 'none' ? 0 : skidAmount * (skidKind === 'tarmac' ? 0.5 : 0.35)
        skidGain.gain.setTargetAtTime(skidVol, t, 0.05)
        skidFilter.frequency.setTargetAtTime(skidKind === 'tarmac' ? 1200 + skidAmount * 900 : skidKind === 'gravel' ? 500 : 900, t, 0.05)
        skidFilter.Q.value = skidKind === 'tarmac' ? 2.5 : 0.6
        nitroGain.gain.setTargetAtTime(nitroOn ? 0.25 : 0, t, 0.08)
      },
      dispose: () => {
        voices.delete(handle)
        engine.dispose()
        try {
          skid.stop()
          nitro.stop()
        } catch {
          /* ignore */
        }
        panner.disconnect()
      },
    }
    this.voices.add(handle)
    return handle
  }

  // ---------------------------------------------------------------------------
  // One-shots
  // ---------------------------------------------------------------------------

  private positional(position: THREE.Vector3 | null): AudioNode {
    if (!position) return this.sfxBus
    const p = this.ctx.createPanner()
    p.panningModel = 'equalpower'
    p.refDistance = 5
    p.rolloffFactor = 1
    p.setPosition(position.x, position.y, position.z)
    p.connect(this.sfxBus)
    return p
  }

  playImpact(force: number, position: THREE.Vector3 | null, metallic = true): void {
    if (!this.unlocked) return
    const t = this.ctx.currentTime
    const out = this.positional(position)
    const vol = clamp01(force)
    // Low thump.
    const o = this.ctx.createOscillator()
    o.frequency.setValueAtTime(120, t)
    o.frequency.exponentialRampToValueAtTime(35, t + 0.25)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vol * 0.9, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
    o.connect(g).connect(out)
    o.start(t)
    o.stop(t + 0.4)
    // Crunch noise.
    const n = this.ctx.createBufferSource()
    n.buffer = this.noiseBuffer
    const f = this.ctx.createBiquadFilter()
    f.type = metallic ? 'bandpass' : 'lowpass'
    f.frequency.value = metallic ? 2200 : 700
    const ng = this.ctx.createGain()
    ng.gain.setValueAtTime(vol * 0.7, t)
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.25 + vol * 0.3)
    n.connect(f).connect(ng).connect(out)
    n.start(t)
    n.stop(t + 0.7)
    if (metallic && vol > 0.4) {
      const ring = this.ctx.createOscillator()
      ring.type = 'triangle'
      ring.frequency.value = 1800 + Math.random() * 1200
      const rg = this.ctx.createGain()
      rg.gain.setValueAtTime(vol * 0.12, t)
      rg.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
      ring.connect(rg).connect(out)
      ring.start(t)
      ring.stop(t + 0.55)
    }
  }

  playGearShift(up: boolean, position: THREE.Vector3 | null): void {
    if (!this.unlocked) return
    const t = this.ctx.currentTime
    const out = this.positional(position)
    const n = this.ctx.createBufferSource()
    n.buffer = this.noiseBuffer
    const f = this.ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = up ? 2600 : 1800
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.18, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09)
    n.connect(f).connect(g).connect(out)
    n.start(t)
    n.stop(t + 0.1)
  }

  playBlowoff(pressure: number, position: THREE.Vector3 | null): void {
    if (!this.unlocked) return
    const t = this.ctx.currentTime
    const out = this.positional(position)
    const n = this.ctx.createBufferSource()
    n.buffer = this.noiseBuffer
    const f = this.ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.setValueAtTime(3500, t)
    f.frequency.exponentialRampToValueAtTime(900, t + 0.35)
    f.Q.value = 2
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.35 * pressure, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
    n.connect(f).connect(g).connect(out)
    n.start(t)
    n.stop(t + 0.45)
  }

  playBackfire(position: THREE.Vector3 | null): void {
    this.playImpact(0.35, position, false)
  }

  playCountdown(final: boolean): void {
    if (!this.unlocked) return
    const t = this.ctx.currentTime
    const o = this.ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = final ? 880 : 440
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.18, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + (final ? 0.6 : 0.2))
    o.connect(g).connect(this.sfxBus)
    o.start(t)
    o.stop(t + 0.7)
  }

  playUI(kind: 'hover' | 'click' | 'back' | 'success' | 'error' | 'purchase' | 'levelup'): void {
    if (!this.unlocked) return
    if (kind === 'hover' && this.uiCooldown > 0) return
    this.uiCooldown = 0.03
    const t = this.ctx.currentTime
    const notes: Record<typeof kind, number[]> = {
      hover: [1200],
      click: [880, 1320],
      back: [660, 440],
      success: [523, 659, 784],
      error: [220, 180],
      purchase: [659, 784, 1047, 1319],
      levelup: [523, 659, 784, 1047, 1319],
    }
    notes[kind].forEach((f, i) => {
      const o = this.ctx.createOscillator()
      o.type = kind === 'hover' ? 'sine' : 'triangle'
      o.frequency.value = f
      const g = this.ctx.createGain()
      const start = t + i * 0.07
      g.gain.setValueAtTime(kind === 'hover' ? 0.03 : 0.08, start)
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.15)
      o.connect(g).connect(this.sfxBus)
      o.start(start)
      o.stop(start + 0.16)
    })
  }

  playCheckpoint(): void {
    this.playUI('click')
  }

  playThunder(): void {
    if (!this.unlocked) return
    const t = this.ctx.currentTime
    const n = this.ctx.createBufferSource()
    n.buffer = this.noiseBuffer
    n.playbackRate.value = 0.35
    const f = this.ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 220
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.4)
    g.gain.exponentialRampToValueAtTime(0.001, t + 3.5)
    n.connect(f).connect(g).connect(this.ambienceBus)
    n.start(t)
    n.stop(t + 4)
  }

  setAmbience(params: { speedKmh: number; rain: number; crowd: number; tunnel: number; wind: number }): void {
    const t = this.ctx.currentTime
    this.windGain.gain.setTargetAtTime(clamp01(params.speedKmh / 260) * 0.35 + params.wind * 0.12, t, 0.2)
    this.windFilter.frequency.setTargetAtTime(200 + clamp01(params.speedKmh / 300) * 900, t, 0.2)
    this.rainGain.gain.setTargetAtTime(params.rain * 0.22, t, 0.5)
    this.crowdGain.gain.setTargetAtTime(params.crowd * 0.3, t, 0.3)
    this.reverbSend.gain.setTargetAtTime(params.tunnel * 0.35, t, 0.3)
  }

  dispose(): void {
    for (const v of [...this.voices]) v.dispose()
    this.music.dispose()
    void this.ctx.close()
  }
}
