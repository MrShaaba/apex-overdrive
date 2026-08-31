/**
 * Adaptive procedural music. A step sequencer schedules synthesised drums,
 * bass, pads and arpeggios a few hundred milliseconds ahead of the audio
 * clock. `setIntensity()` (0..1) fades layers in/out and opens filters, so the
 * score swells with speed, final laps and close battles; `setMode()` switches
 * between the calmer menu groove, race energy and the results sting.
 */

export type MusicMode = 'menu' | 'race' | 'results' | 'off'

const SCALE = [0, 2, 3, 5, 7, 8, 10] // natural minor
const PROGRESSIONS = [
  [0, 5, 3, 4],
  [0, 3, 5, 4],
  [0, 6, 3, 4],
]

export class MusicSystem {
  readonly output: GainNode
  private mode: MusicMode = 'off'
  private intensity = 0.3
  private targetIntensity = 0.3
  private tempo = 100
  private nextStepTime = 0
  private step = 0
  private timer: number | null = null
  private readonly noiseBuffer: AudioBuffer
  private readonly padGain: GainNode
  private readonly bassGain: GainNode
  private readonly drumGain: GainNode
  private readonly arpGain: GainNode
  private readonly padFilter: BiquadFilterNode
  private progression = PROGRESSIONS[0]
  private root = 45 // A2 midi
  private bar = 0

  constructor(private readonly ctx: AudioContext) {
    this.output = ctx.createGain()
    this.output.gain.value = 0
    this.padGain = ctx.createGain()
    this.bassGain = ctx.createGain()
    this.drumGain = ctx.createGain()
    this.arpGain = ctx.createGain()
    this.padFilter = ctx.createBiquadFilter()
    this.padFilter.type = 'lowpass'
    this.padFilter.frequency.value = 800
    this.padGain.connect(this.padFilter).connect(this.output)
    this.bassGain.connect(this.output)
    this.drumGain.connect(this.output)
    this.arpGain.connect(this.output)
    this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 1, ctx.sampleRate)
    const d = this.noiseBuffer.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }

  setMode(mode: MusicMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.tempo = mode === 'menu' ? 96 : mode === 'race' ? 132 : 110
    this.progression = PROGRESSIONS[Math.floor(Math.random() * PROGRESSIONS.length)]
    this.root = mode === 'race' ? 43 : 45
    const t = this.ctx.currentTime
    this.output.gain.setTargetAtTime(mode === 'off' ? 0 : 1, t, 0.8)
    if (mode !== 'off' && this.timer === null) {
      this.nextStepTime = this.ctx.currentTime + 0.1
      this.step = 0
      this.timer = window.setInterval(() => this.schedule(), 60)
    }
    if (mode === 'off' && this.timer !== null) {
      window.setTimeout(() => {
        if (this.mode === 'off' && this.timer !== null) {
          clearInterval(this.timer)
          this.timer = null
        }
      }, 1500)
    }
  }

  setIntensity(v: number): void {
    this.targetIntensity = Math.max(0, Math.min(1, v))
  }

  setVolume(v: number): void {
    this.output.gain.setTargetAtTime(this.mode === 'off' ? 0 : v, this.ctx.currentTime, 0.2)
  }

  private schedule(): void {
    const lookahead = 0.25
    while (this.nextStepTime < this.ctx.currentTime + lookahead) {
      this.playStep(this.step, this.nextStepTime)
      const stepDur = 60 / this.tempo / 4
      this.nextStepTime += stepDur
      this.step = (this.step + 1) % 64
      if (this.step === 0) this.bar++
    }
    this.intensity += (this.targetIntensity - this.intensity) * 0.05
    const t = this.ctx.currentTime
    this.padFilter.frequency.setTargetAtTime(500 + this.intensity * 3500, t, 0.3)
    this.arpGain.gain.setTargetAtTime(this.mode === 'race' ? 0.05 + this.intensity * 0.12 : 0.06, t, 0.3)
    this.drumGain.gain.setTargetAtTime(this.mode === 'menu' ? 0.25 : 0.3 + this.intensity * 0.5, t, 0.3)
    this.bassGain.gain.setTargetAtTime(0.35 + this.intensity * 0.3, t, 0.3)
    this.padGain.gain.setTargetAtTime(0.5, t, 0.3)
  }

  private midiToHz(m: number): number {
    return 440 * Math.pow(2, (m - 69) / 12)
  }

  private playStep(step: number, time: number): void {
    const chordIndex = Math.floor(step / 16) % this.progression.length
    const degree = this.progression[chordIndex]
    const chordRoot = this.root + SCALE[degree % 7] + (degree >= 7 ? 12 : 0)
    const inBar = step % 16
    const drums = this.mode === 'race' || this.intensity > 0.45 || this.mode === 'results'
    // Drums.
    if (drums) {
      if (inBar % 4 === 0) this.kick(time)
      if (inBar === 4 || inBar === 12) this.snare(time, 0.5)
      if (inBar % 2 === 1 || this.intensity > 0.6) this.hat(time, inBar % 4 === 2 ? 0.25 : 0.12)
      if (this.intensity > 0.75 && inBar === 14) this.snare(time, 0.25)
    } else if (inBar === 0 || inBar === 8) this.kick(time, 0.5)
    // Bass.
    if (inBar % 2 === 0) {
      const octaveJump = this.mode === 'race' && inBar % 8 === 6 ? 12 : 0
      this.bass(this.midiToHz(chordRoot - 12 + octaveJump), time, 60 / this.tempo / 4 * 1.8)
    }
    // Pad at chord changes.
    if (inBar === 0) {
      const dur = (60 / this.tempo) * 4
      for (const iv of [0, 3, 7, 10]) this.pad(this.midiToHz(chordRoot + iv), time, dur)
    }
    // Arp.
    if (this.intensity > 0.3 || this.mode === 'menu') {
      const arpNotes = [0, 3, 7, 12, 7, 3]
      const n = arpNotes[step % arpNotes.length]
      if (inBar % 2 === 0 || this.intensity > 0.7) this.arp(this.midiToHz(chordRoot + 12 + n), time, 60 / this.tempo / 4 * 0.9)
    }
  }

  private kick(t: number, vel = 1): void {
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.frequency.setValueAtTime(150, t)
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12)
    g.gain.setValueAtTime(0.9 * vel, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
    o.connect(g).connect(this.drumGain)
    o.start(t)
    o.stop(t + 0.32)
  }

  private snare(t: number, vel: number): void {
    const s = this.ctx.createBufferSource()
    s.buffer = this.noiseBuffer
    const f = this.ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = 1800
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vel, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
    s.connect(f).connect(g).connect(this.drumGain)
    s.start(t)
    s.stop(t + 0.2)
  }

  private hat(t: number, vel: number): void {
    const s = this.ctx.createBufferSource()
    s.buffer = this.noiseBuffer
    const f = this.ctx.createBiquadFilter()
    f.type = 'highpass'
    f.frequency.value = 7000
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vel, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
    s.connect(f).connect(g).connect(this.drumGain)
    s.start(t)
    s.stop(t + 0.06)
  }

  private bass(freq: number, t: number, dur: number): void {
    const o = this.ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.value = freq
    const f = this.ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(200 + this.intensity * 900, t)
    f.frequency.exponentialRampToValueAtTime(120, t + dur)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.5, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    o.connect(f).connect(g).connect(this.bassGain)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  private pad(freq: number, t: number, dur: number): void {
    for (const det of [-6, 6]) {
      const o = this.ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = freq
      o.detune.value = det
      const g = this.ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.06, t + dur * 0.2)
      g.gain.linearRampToValueAtTime(0, t + dur)
      o.connect(g).connect(this.padGain)
      o.start(t)
      o.stop(t + dur + 0.02)
    }
  }

  private arp(freq: number, t: number, dur: number): void {
    const o = this.ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = freq
    const f = this.ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 1200 + this.intensity * 3000
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.5, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    o.connect(f).connect(g).connect(this.arpGain)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.output.disconnect()
  }
}
