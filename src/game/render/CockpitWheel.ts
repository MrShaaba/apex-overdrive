/**
 * Cockpit steering wheel, shown only in the cockpit camera. The whole
 * assembly is parented to the camera so it stays glued to the view (and
 * inherits impact shake); a spinner group rotates with the live steering
 * angle, and a CanvasTexture centre display shows the gear, speed, RPM shift
 * lights and — when the systems provide them — ERS charge and DRS state.
 *
 * The rim is the licensed McLaren wheel model when `setModel()` has been
 * given it (Engine preloads public/assets/models/cockpit/mclaren_wheel.glb,
 * built by tools/asset-pipeline/prepare-car.mjs with its steering axis at
 * the origin and +Z facing the driver); the original procedural rim is the
 * fallback when the file is missing.
 */

import * as THREE from 'three'
import { clamp01 } from '../core/MathUtils'

export interface WheelTelemetry {
  /** Road-wheel steering angle in radians (positive = right). */
  steerAngle: number
  /** The car's maximum steering angle in radians, for normalisation. */
  maxSteerAngle: number
  gear: number
  speedKmh: number
  rpm: number
  redline: number
  limiter: boolean
  units: 'kmh' | 'mph'
  /** ERS battery charge 0..1. */
  ers: number
  ersMode: 'deploy' | 'harvest' | 'idle'
  drs: 'none' | 'available' | 'active'
  pitLimiter: boolean
}

/** Visual rim rotation at full steering input. */
const VISUAL_LOCK = 1.55
const LED_COUNT = 15

export class CockpitWheel {
  readonly root = new THREE.Group()
  private readonly spinner = new THREE.Group()
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly tex: THREE.CanvasTexture
  private readonly geometries: THREE.BufferGeometry[] = []
  private readonly materials: THREE.Material[] = []
  private rimAngle = 0
  private repaintTimer = 0
  private lastPaintKey = ''
  private dash!: THREE.Group
  /** Procedural rim parts, hidden when the licensed model is in. */
  private readonly proceduralRim: THREE.Object3D[] = []
  private readonly display: THREE.Mesh
  private column: THREE.Mesh
  private model: THREE.Group | null = null

  constructor() {
    this.root.name = 'cockpit-wheel'
    this.root.position.set(0, -0.22, -0.5)
    this.root.rotation.x = -0.28
    this.root.visible = false

    this.canvas = document.createElement('canvas')
    this.canvas.width = 512
    this.canvas.height = 336
    this.ctx = this.canvas.getContext('2d')!
    this.tex = new THREE.CanvasTexture(this.canvas)
    this.tex.colorSpace = THREE.SRGBColorSpace

    const rubber = this.mat(new THREE.MeshStandardMaterial({ color: 0x181a1f, roughness: 0.88, metalness: 0.05 }))
    const carbon = this.mat(new THREE.MeshStandardMaterial({ color: 0x22252c, roughness: 0.4, metalness: 0.45 }))
    const accent = this.mat(new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.35, metalness: 0.3, emissive: 0xff6a00, emissiveIntensity: 0.25 }))
    const blue = this.mat(new THREE.MeshStandardMaterial({ color: 0x2f9dff, roughness: 0.35, metalness: 0.3, emissive: 0x2f9dff, emissiveIntensity: 0.25 }))
    const screen = this.mat(new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }))

    const rimPart = <T extends THREE.Object3D>(o: T): T => {
      this.proceduralRim.push(o)
      return o
    }
    // Top arc of the rim (2 rad sweep centred on 12 o'clock).
    const arc = rimPart(new THREE.Mesh(this.geo(new THREE.TorusGeometry(0.165, 0.026, 12, 28, 2)), rubber))
    arc.rotation.z = Math.PI / 2 - 1
    this.spinner.add(arc)
    // Vertical hand grips, tops leaning inward to meet the arc ends.
    for (const s of [-1, 1]) {
      const grip = rimPart(new THREE.Mesh(this.geo(new THREE.CapsuleGeometry(0.031, 0.155, 6, 12)), rubber))
      grip.position.set(s * 0.153, -0.02, 0)
      grip.rotation.z = -s * 0.17
      this.spinner.add(grip)
      // Orange thumb rest at the top of each grip.
      const band = rimPart(new THREE.Mesh(this.geo(new THREE.TorusGeometry(0.032, 0.006, 8, 16)), accent))
      band.position.set(s * 0.141, 0.05, 0)
      band.rotation.x = Math.PI / 2
      band.rotation.z = -s * 0.17
      this.spinner.add(band)
    }
    // Flat bottom bar.
    const bottom = rimPart(new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.2, 0.042, 0.05)), rubber))
    bottom.position.set(0, -0.152, 0)
    this.spinner.add(bottom)
    // Centre body and display.
    const body = rimPart(new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.2, 0.15, 0.048)), carbon))
    body.position.set(0, 0.005, 0)
    this.spinner.add(body)
    const display = (this.display = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(0.172, 0.113)), screen))
    display.position.set(0, 0.012, 0.0255)
    this.spinner.add(display)
    // Rotary knobs and buttons on the lower face.
    for (const [x, m] of [[-0.072, accent], [0.072, blue]] as const) {
      const knob = rimPart(new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.016, 0.016, 0.02, 14)), m))
      knob.position.set(x, -0.062, 0.028)
      knob.rotation.x = Math.PI / 2
      this.spinner.add(knob)
    }
    // Shift paddles behind the wheel.
    for (const s of [-1, 1]) {
      const paddle = rimPart(new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.042, 0.09, 0.006)), carbon))
      paddle.position.set(s * 0.108, -0.015, -0.04)
      paddle.rotation.y = -s * 0.3
      this.spinner.add(paddle)
    }
    this.root.add(this.spinner)
    // Steering column (does not rotate with the rim).
    const column = (this.column = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.023, 0.03, 0.2, 12)), carbon))
    column.rotation.x = Math.PI / 2
    column.position.set(0, -0.02, -0.12)
    this.root.add(column)
    // Dashboard: a wide tilted plate behind the wheel so the bottom of the
    // view reads as the inside of the car (the body shell is hidden in
    // cockpit view — there is no modelled interior).
    const cowlMat = this.mat(new THREE.MeshStandardMaterial({ color: 0x0d0f13, roughness: 0.95, metalness: 0.05 }))
    const dash = (this.dash = new THREE.Group())
    dash.position.set(0, -0.44, -0.45)
    dash.rotation.x = 0.45
    const plate = new THREE.Mesh(this.geo(new THREE.BoxGeometry(1.7, 0.03, 0.55)), cowlMat)
    dash.add(plate)
    const trim = new THREE.Mesh(this.geo(new THREE.BoxGeometry(1.7, 0.014, 0.022)), accent)
    trim.position.set(0, 0.022, -0.26)
    dash.add(trim)
    this.root.add(dash)

    this.paint({ steerAngle: 0, maxSteerAngle: 1, gear: 0, speedKmh: 0, rpm: 0, redline: 8000, limiter: false, units: 'kmh', ers: 1, ersMode: 'idle', drs: 'none', pitLimiter: false })
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g)
    return g
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.materials.push(m)
    return m
  }

  /** Per-frame update. Pass null when the wheel should not be shown. */
  update(dt: number, data: WheelTelemetry | null): void {
    if (!data) {
      this.root.visible = false
      return
    }
    this.root.visible = true
    const steerNorm = THREE.MathUtils.clamp(data.steerAngle / Math.max(0.01, data.maxSteerAngle), -1, 1)
    // Light smoothing keeps keyboard steps from snapping the rim.
    const target = -steerNorm * VISUAL_LOCK
    this.rimAngle += (target - this.rimAngle) * (1 - Math.exp(-18 * dt))
    this.spinner.rotation.z = this.rimAngle

    this.repaintTimer += dt
    const rpmT = clamp01(data.rpm / Math.max(1, data.redline))
    const leds = Math.round(clamp01((rpmT - 0.5) / 0.48) * LED_COUNT)
    const speed = Math.round(data.units === 'mph' ? data.speedKmh * 0.621371 : data.speedKmh)
    const key = `${data.gear}|${speed}|${leds}|${data.limiter}|${data.units}|${Math.round(data.ers * 100)}|${data.ersMode}|${data.drs}|${data.pitLimiter}`
    if (key !== this.lastPaintKey || this.repaintTimer > 0.15) {
      this.lastPaintKey = key
      this.repaintTimer = 0
      this.paint(data)
    }
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible
  }

  /**
   * Swap the procedural rim for a licensed wheel model (steering axis at the
   * origin, +Z toward the driver, metres). The canvas display moves onto the
   * model's screen so the gear/speed/ERS readout keeps working; the model's
   * own quick-release hub replaces the procedural column.
   */
  setModel(template: THREE.Group | null): void {
    if (this.model) {
      this.spinner.remove(this.model)
      this.model = null
    }
    const on = template !== null
    for (const o of this.proceduralRim) o.visible = !on
    this.column.visible = !on
    if (template) {
      const model = template.clone(true)
      model.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = false
          o.receiveShadow = false
        }
      })
      this.model = model
      this.spinner.add(model)
      // The McLaren wheel's screen sits at the top centre, 0.10 × 0.06 m,
      // just behind a glass cover; park the readout a hair in front of it.
      this.display.geometry.dispose()
      this.display.geometry = this.geo(new THREE.PlaneGeometry(0.098, 0.064))
      this.display.position.set(0, 0.057, 0.005)
    } else {
      this.display.geometry.dispose()
      this.display.geometry = this.geo(new THREE.PlaneGeometry(0.172, 0.113))
      this.display.position.set(0, 0.012, 0.0255)
    }
  }

  /** Road cars show the wide dashboard plate; open formula cockpits hide it
   * so the halo and tub read as the cockpit frame instead. */
  setDash(visible: boolean): void {
    this.dash.visible = visible
  }

  private paint(data: WheelTelemetry): void {
    const ctx = this.ctx
    const w = this.canvas.width
    const h = this.canvas.height
    ctx.fillStyle = '#07090d'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = '#ff6a00'
    ctx.lineWidth = 6
    ctx.strokeRect(3, 3, w - 6, h - 6)

    // Shift lights: green → red → blue, all flashing on the limiter.
    const rpmT = clamp01(data.rpm / Math.max(1, data.redline))
    const lit = Math.round(clamp01((rpmT - 0.5) / 0.48) * LED_COUNT)
    const flashOn = data.limiter
    for (let i = 0; i < LED_COUNT; i++) {
      const x = 38 + (i * (w - 76)) / (LED_COUNT - 1)
      const on = flashOn || i < lit
      const color = i < 5 ? '#43e07a' : i < 10 ? '#ff4d5e' : '#4db6ff'
      ctx.beginPath()
      ctx.arc(x, 36, 13, 0, Math.PI * 2)
      ctx.fillStyle = on ? color : '#1a2027'
      ctx.fill()
      if (on) {
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }

    // Gear (big, centre-left).
    const gearLabel = data.gear === 0 ? 'N' : data.gear < 0 ? 'R' : String(data.gear)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = data.limiter ? '#ff4d5e' : '#ffffff'
    ctx.font = '900 148px system-ui, sans-serif'
    ctx.fillText(gearLabel, 140, 168)
    ctx.fillStyle = '#5a6472'
    ctx.font = '700 24px system-ui, sans-serif'
    ctx.fillText('GEAR', 140, 250)

    // Speed (right column).
    ctx.fillStyle = '#7ef0ff'
    ctx.font = '800 92px system-ui, sans-serif'
    ctx.fillText(String(Math.round(data.units === 'mph' ? data.speedKmh * 0.621371 : data.speedKmh)), 366, 152)
    ctx.fillStyle = '#5a6472'
    ctx.font = '700 24px system-ui, sans-serif'
    ctx.fillText(data.units === 'mph' ? 'MPH' : 'KM/H', 366, 212)

    // RPM readout.
    ctx.fillStyle = '#38414c'
    ctx.font = '700 22px system-ui, sans-serif'
    ctx.fillText(`${Math.round(data.rpm)} RPM`, w / 2, 246)

    // Bottom row: ERS battery bar (cyan deploy / green harvest / orange rest)
    // with a DRS or PIT status chip beside it.
    const barX = 38
    const barY = 272
    const barW = 300
    const barH = 34
    const color = data.ersMode === 'deploy' ? '#7ef0ff' : data.ersMode === 'harvest' ? '#54e082' : '#ff9d45'
    ctx.strokeStyle = '#38414c'
    ctx.lineWidth = 3
    ctx.strokeRect(barX, barY, barW, barH)
    ctx.fillStyle = color
    ctx.fillRect(barX + 3, barY + 3, Math.max(0, (barW - 6) * clamp01(data.ers)), barH - 6)
    ctx.fillStyle = '#ffffff'
    ctx.font = '800 24px system-ui, sans-serif'
    const ersLabel = data.ersMode === 'deploy' ? 'DEPLOY' : data.ersMode === 'harvest' ? 'CHARGING' : 'ERS'
    ctx.fillText(`${ersLabel} ${Math.round(clamp01(data.ers) * 100)}%`, barX + barW / 2, barY + barH / 2 + 1)

    const chipX = barX + barW + 12
    const chipW = w - 38 - chipX
    const chipColor = data.pitLimiter ? '#ffd60a' : data.drs === 'active' ? '#54e082' : data.drs === 'available' ? '#ffd60a' : '#2a323d'
    ctx.strokeStyle = chipColor
    ctx.strokeRect(chipX, barY, chipW, barH)
    if (data.pitLimiter || data.drs === 'active') {
      ctx.fillStyle = chipColor
      ctx.fillRect(chipX + 3, barY + 3, chipW - 6, barH - 6)
      ctx.fillStyle = '#07090d'
    } else ctx.fillStyle = data.drs === 'available' ? chipColor : '#4a5563'
    ctx.font = '800 24px system-ui, sans-serif'
    ctx.fillText(data.pitLimiter ? 'PIT' : 'DRS', chipX + chipW / 2, barY + barH / 2 + 1)

    this.tex.needsUpdate = true
  }

  dispose(): void {
    this.root.removeFromParent()
    for (const g of this.geometries) g.dispose()
    for (const m of this.materials) m.dispose()
    this.tex.dispose()
  }
}
