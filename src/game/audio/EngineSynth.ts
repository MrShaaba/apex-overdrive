/**
 * Procedural engine voice built from layered oscillators + filtered noise.
 * Firing frequency = rpm / 60 × cylinders / 2. Layers: fundamental saw,
 * sub-octave square (rumble), 2× harmonic through a low-pass (load growl),
 * intake/exhaust noise, plus turbo whistle and EV inverter whine variants.
 */

import type { VehicleSpec } from '../vehicles/VehicleSpec'

export interface EngineVoiceParams {
  rpm: number
  throttle: number
  load: number
  boost: number
  nitro: boolean
  limiter: boolean
  redline: number
}

export class EngineVoice {
  readonly output: GainNode
  private readonly oscs: OscillatorNode[] = []
  private readonly gains: GainNode[] = []
  private readonly filter: BiquadFilterNode
  private readonly noise: AudioBufferSourceNode
  private readonly noiseGain: GainNode
  private readonly noiseFilter: BiquadFilterNode
  private readonly turboOsc: OscillatorNode | null = null
  private readonly turboGain: GainNode | null = null
  private readonly shaper: WaveShaperNode
  private readonly profile: VehicleSpec['engine']['soundProfile']
  private readonly cylinders: number
  private active = true
  private started = false

  constructor(
    private readonly ctx: AudioContext,
    spec: VehicleSpec,
    noiseBuffer: AudioBuffer,
  ) {
    this.profile = spec.engine.soundProfile
    this.cylinders = Math.max(2, spec.engine.cylinders || 8)
    this.output = ctx.createGain()
    this.output.gain.value = 0
    this.shaper = ctx.createWaveShaper()
    this.shaper.curve = makeDistortionCurve(this.profile === 'ev' ? 4 : this.profile === 'v8' ? 45 : 28)
    this.shaper.oversample = '2x'
    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'lowpass'
    this.filter.frequency.value = 900
    this.filter.Q.value = 0.8
    this.shaper.connect(this.filter).connect(this.output)

    const isEv = this.profile === 'ev'
    const layerDefs: { type: OscillatorType; mult: number; gain: number; detune: number }[] = isEv
      ? [
          { type: 'sine', mult: 1, gain: 0.5, detune: 0 },
          { type: 'sine', mult: 2.01, gain: 0.25, detune: 4 },
          { type: 'triangle', mult: 4.02, gain: 0.12, detune: -3 },
        ]
      : [
          { type: 'sawtooth', mult: 1, gain: 0.55, detune: 0 },
          { type: 'square', mult: 0.5, gain: 0.35, detune: 3 },
          { type: 'sawtooth', mult: 2, gain: 0.22, detune: -5 },
          { type: 'triangle', mult: this.profile === 'v8' ? 1.5 : this.profile === 'v12' || this.profile === 'v10' ? 3 : 2.5, gain: 0.14, detune: 7 },
        ]
    for (const def of layerDefs) {
      const osc = ctx.createOscillator()
      osc.type = def.type
      osc.detune.value = def.detune
      const g = ctx.createGain()
      g.gain.value = def.gain
      osc.connect(g).connect(this.shaper)
      this.oscs.push(osc)
      this.gains.push(g)
    }
    // Noise layer (intake / exhaust roar).
    this.noise = ctx.createBufferSource()
    this.noise.buffer = noiseBuffer
    this.noise.loop = true
    this.noiseFilter = ctx.createBiquadFilter()
    this.noiseFilter.type = 'bandpass'
    this.noiseFilter.frequency.value = 600
    this.noiseFilter.Q.value = 0.7
    this.noiseGain = ctx.createGain()
    this.noiseGain.gain.value = 0
    this.noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.output)

    if (spec.engine.turbo || spec.engine.supercharged || this.profile === 'hybrid') {
      this.turboOsc = ctx.createOscillator()
      this.turboOsc.type = 'sine'
      this.turboOsc.frequency.value = 900
      this.turboGain = ctx.createGain()
      this.turboGain.gain.value = 0
      this.turboOsc.connect(this.turboGain).connect(this.output)
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    const t = this.ctx.currentTime
    for (const o of this.oscs) o.start(t)
    this.noise.start(t)
    this.turboOsc?.start(t)
  }

  setActive(active: boolean): void {
    this.active = active
    if (!active) this.output.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05)
  }

  update(p: EngineVoiceParams, volume: number): void {
    if (!this.started || !this.active) return
    const t = this.ctx.currentTime
    const isEv = this.profile === 'ev'
    const firing = isEv ? (p.rpm / 60) * 0.6 + 40 : Math.max(8, (p.rpm / 60) * (this.cylinders / 2))
    const layerMults = isEv ? [1, 2.01, 4.02] : [1, 0.5, 2, this.profile === 'v8' ? 1.5 : this.profile === 'v12' || this.profile === 'v10' ? 3 : 2.5]
    this.oscs.forEach((o, i) => {
      o.frequency.setTargetAtTime(firing * layerMults[i], t, 0.03)
    })
    const rpmT = p.rpm / p.redline
    const load = p.load
    // Load opens the low-pass and lifts the harmonics.
    this.filter.frequency.setTargetAtTime(isEv ? 2000 + rpmT * 4000 : 400 + rpmT * 1800 + load * 1400 + (p.nitro ? 800 : 0), t, 0.05)
    this.gains[2]?.gain.setTargetAtTime((isEv ? 0.12 : 0.22) * (0.4 + load * 0.9), t, 0.05)
    this.noiseFilter.frequency.setTargetAtTime(300 + rpmT * 1500, t, 0.05)
    this.noiseGain.gain.setTargetAtTime(isEv ? 0.02 + load * 0.04 : 0.05 + load * 0.22 + rpmT * 0.08, t, 0.05)
    if (this.turboOsc && this.turboGain) {
      this.turboOsc.frequency.setTargetAtTime(700 + p.boost * 2600 + rpmT * 600, t, 0.08)
      this.turboGain.gain.setTargetAtTime(p.boost * 0.05 * (0.5 + load * 0.5), t, 0.08)
    }
    const limiterDuck = p.limiter ? 0.55 : 1
    const base = isEv ? 0.35 + rpmT * 0.45 : 0.32 + rpmT * 0.45 + load * 0.25
    this.output.gain.setTargetAtTime(base * volume * limiterDuck, t, 0.04)
  }

  dispose(): void {
    try {
      for (const o of this.oscs) o.stop()
      this.noise.stop()
      this.turboOsc?.stop()
    } catch {
      /* already stopped */
    }
    this.output.disconnect()
  }
}

export function makeDistortionCurve(amount: number): Float32Array {
  const n = 256
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1
    curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x))
  }
  return curve
}
