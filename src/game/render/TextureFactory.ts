/**
 * Procedural texture factory + streaming cache.
 *
 * The game ships no binary texture assets: every surface, sprite, livery and
 * sign is painted onto a canvas on demand. Textures are cached by key, created
 * at a resolution scaled by the active quality tier (`setScale`), and can be
 * released with `releaseUnused()` when a track is unloaded so GPU memory stays
 * bounded. Optional `public/assets/textures/*.jpg` overrides are picked up if a
 * matching file exists in the manifest (see docs/ASSET_PIPELINE.md).
 *
 * `image()` loads an image file into the same cache: same keying, same
 * `releaseUnused()` lifecycle, so photos on a track's billboards are freed with
 * the rest of that track's textures.
 */

const log = Logger.scope('Textures')

import * as THREE from 'three'
import { createRng, fbm2D, hashString } from '../core/MathUtils'
import { Logger } from '../core/Logger'
import type { LiveryStyle, VehicleCustomization } from '../vehicles/VehicleSpec'

type Painter = (ctx: CanvasRenderingContext2D, size: number, rng: () => number) => void

interface TextureOptions {
  size?: number
  repeat?: [number, number]
  srgb?: boolean
  wrap?: boolean
  anisotropy?: number
  mipmaps?: boolean
  fixedSize?: boolean
  /** Canvas height when the texture is not square (defaults to the width). */
  height?: number
}

interface CacheEntry {
  texture: THREE.Texture
  lastUsed: number
  bytes: number
}

export class TextureFactory {
  private cache = new Map<string, CacheEntry>()
  private scale = 1
  private anisotropy = 4
  private frame = 0
  private bytes = 0

  setScale(scale: number): void {
    if (scale !== this.scale) {
      this.scale = scale
      // Textures will be regenerated lazily at the new size.
      this.releaseAll()
    }
  }

  setAnisotropy(a: number): void {
    this.anisotropy = a
  }

  tick(): void {
    this.frame++
  }

  get memoryBytes(): number {
    return this.bytes
  }

  private makeCanvas(size: number, height = size): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const c = document.createElement('canvas')
    c.width = size
    c.height = height
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    return [c, ctx]
  }

  /** Get-or-create a texture. */
  get(key: string, painter: Painter, opts: TextureOptions = {}): THREE.Texture {
    const hit = this.cache.get(key)
    if (hit) {
      hit.lastUsed = this.frame
      return hit.texture
    }
    const base = opts.size ?? 512
    const size = opts.fixedSize ? base : Math.max(64, Math.round(base * this.scale))
    const height = opts.height ? (opts.fixedSize ? opts.height : Math.max(16, Math.round(opts.height * this.scale))) : size
    const [canvas, ctx] = this.makeCanvas(size, height)
    const rng = createRng(hashString(key))
    painter(ctx, size, rng)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace
    if (opts.wrap !== false) tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    if (opts.repeat) tex.repeat.set(opts.repeat[0], opts.repeat[1])
    tex.anisotropy = opts.anisotropy ?? this.anisotropy
    tex.generateMipmaps = opts.mipmaps !== false
    tex.minFilter = opts.mipmaps === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter
    tex.needsUpdate = true
    const bytes = size * height * 4 * 1.33
    this.cache.set(key, { texture: tex, lastUsed: this.frame, bytes })
    this.bytes += bytes
    return tex
  }

  release(key: string): void {
    const e = this.cache.get(key)
    if (!e) return
    e.texture.dispose()
    this.bytes -= e.bytes
    this.cache.delete(key)
  }

  /** Free textures not used in the last `maxAge` frames (call between sessions). */
  releaseUnused(maxAge = 600): void {
    for (const [key, e] of this.cache) if (this.frame - e.lastUsed > maxAge) this.release(key)
  }

  releaseAll(): void {
    for (const key of [...this.cache.keys()]) this.release(key)
  }

  /**
   * An image file under the app base URL as a texture, cached and released like the
   * painted ones. Returns at once showing `placeholder`'s image (or a grey pixel) and
   * swaps the file in when it has loaded; a missing or broken file keeps the
   * placeholder and logs once. sRGB, mipmapped, with the factory's anisotropy.
   */
  image(file: string, placeholder?: THREE.Texture): THREE.Texture {
    const key = `image:${file}`
    const hit = this.cache.get(key)
    if (hit) {
      hit.lastUsed = this.frame
      return hit.texture
    }
    const tex = new THREE.Texture(placeholder?.image ?? this.greyPixel())
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    tex.anisotropy = this.anisotropy
    tex.generateMipmaps = true
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.needsUpdate = true
    const entry: CacheEntry = { texture: tex, lastUsed: this.frame, bytes: 4 }
    this.cache.set(key, entry)
    this.bytes += entry.bytes
    const url = `${import.meta.env.BASE_URL}${file.replace(/^\/+/, '')}`
    new THREE.ImageLoader().load(
      url,
      (img) => {
        if (this.cache.get(key) !== entry) return // released while it was loading
        tex.image = img
        tex.needsUpdate = true
        const bytes = img.width * img.height * 4 * 1.33
        this.bytes += bytes - entry.bytes
        entry.bytes = bytes
      },
      undefined,
      () => {
        if (this.cache.get(key) === entry) log.warn(`Image ${file} failed to load — placeholder kept`)
      },
    )
    return tex
  }

  private greyPixel(): HTMLCanvasElement {
    const [c, ctx] = this.makeCanvas(2)
    ctx.fillStyle = '#9a9c9e'
    ctx.fillRect(0, 0, 2, 2)
    return c
  }

  // ---------------------------------------------------------------------------
  // Surface painters
  // ---------------------------------------------------------------------------

  noiseFill(ctx: CanvasRenderingContext2D, size: number, base: [number, number, number], variance: number, scale: number, seed: number): void {
    const img = ctx.createImageData(size, size)
    const d = img.data
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n = fbm2D((x / size) * scale, (y / size) * scale, 4, seed)
        const i = (y * size + x) * 4
        d[i] = clampByte(base[0] + n * variance)
        d[i + 1] = clampByte(base[1] + n * variance)
        d[i + 2] = clampByte(base[2] + n * variance)
        d[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }

  road(color = '#2e2f33'): THREE.Texture {
    return this.get(`road:${color}`, (ctx, size, rng) => {
      const c = hexToRgb(color)
      this.noiseFill(ctx, size, c, 22, 12, 3)
      // Fine aggregate speckle.
      for (let i = 0; i < size * size * 0.02; i++) {
        const v = 120 + rng() * 90
        ctx.fillStyle = `rgba(${v},${v},${v},${0.18 + rng() * 0.2})`
        ctx.fillRect(rng() * size, rng() * size, 1.5, 1.5)
      }
      // Tyre wear tracks (darker bands) + centre dashes.
      ctx.fillStyle = 'rgba(0,0,0,0.12)'
      ctx.fillRect(size * 0.2, 0, size * 0.14, size)
      ctx.fillRect(size * 0.66, 0, size * 0.14, size)
      ctx.fillStyle = 'rgba(235,235,225,0.85)'
      const dash = size / 6
      for (let y = 0; y < size; y += dash * 2) ctx.fillRect(size * 0.49, y, size * 0.02, dash)
      ctx.fillStyle = 'rgba(240,240,230,0.9)'
      ctx.fillRect(size * 0.015, 0, size * 0.015, size)
      ctx.fillRect(size * 0.97, 0, size * 0.015, size)
    }, { size: 1024, repeat: [1, 8] })
  }

  curb(): THREE.Texture {
    return this.get('curb', (ctx, size) => {
      const bands = 8
      for (let i = 0; i < bands; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#d8182c' : '#f2f2ec'
        ctx.fillRect(0, (i * size) / bands, size, size / bands)
      }
      ctx.fillStyle = 'rgba(0,0,0,0.15)'
      for (let i = 0; i < 400; i++) ctx.fillRect(Math.random() * size, Math.random() * size, 3, 3)
    }, { size: 256, repeat: [1, 1] })
  }

  ground(kind: 'grass' | 'sand' | 'dirt' | 'gravel' | 'snow' | 'rock' | 'concrete' | 'asphalt', color: string): THREE.Texture {
    return this.get(`ground:${kind}:${color}`, (ctx, size, rng) => {
      const c = hexToRgb(color)
      const variance = kind === 'grass' ? 34 : kind === 'snow' ? 10 : kind === 'gravel' ? 40 : 26
      this.noiseFill(ctx, size, c, variance, kind === 'concrete' ? 6 : 16, hashString(kind) % 97)
      const specks = kind === 'gravel' ? 0.05 : kind === 'grass' ? 0.03 : 0.01
      for (let i = 0; i < size * size * specks; i++) {
        const v = kind === 'snow' ? 240 + rng() * 15 : 40 + rng() * 120
        ctx.fillStyle = `rgba(${v},${v * (kind === 'grass' ? 1.1 : 1)},${v * (kind === 'grass' ? 0.6 : 0.9)},${0.15 + rng() * 0.25})`
        ctx.fillRect(rng() * size, rng() * size, 1 + rng() * 2, 1 + rng() * 2)
      }
      if (kind === 'concrete') {
        ctx.strokeStyle = 'rgba(0,0,0,0.25)'
        ctx.lineWidth = 2
        ctx.strokeRect(1, 1, size - 2, size - 2)
      }
    }, { size: 512, repeat: [40, 40] })
  }

  facade(style: 'glass' | 'brick' | 'concrete' | 'neon' | 'warehouse', seed: number, night: boolean): THREE.Texture {
    return this.get(`facade:${style}:${seed}:${night ? 'n' : 'd'}`, (ctx, size, rng) => {
      const base = style === 'glass' ? '#1e2a3a' : style === 'brick' ? '#6d3f33' : style === 'neon' ? '#141322' : style === 'warehouse' ? '#5a5e63' : '#7a7c80'
      ctx.fillStyle = base
      ctx.fillRect(0, 0, size, size)
      const cols = style === 'warehouse' ? 4 : 8
      const rows = style === 'warehouse' ? 3 : 12
      const cw = size / cols
      const rh = size / rows
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const lit = night && rng() > (style === 'neon' ? 0.35 : 0.55)
          const glow = lit ? (style === 'neon' ? ['#ff2d95', '#7ef0ff', '#ffd60a', '#b06bff'][Math.floor(rng() * 4)] : `rgba(255,${210 + rng() * 40},${150 + rng() * 60},1)`) : `rgba(${40 + rng() * 40},${50 + rng() * 50},${70 + rng() * 60},1)`
          ctx.fillStyle = glow
          ctx.fillRect(c * cw + cw * 0.15, r * rh + rh * 0.2, cw * 0.7, rh * 0.55)
          if (style === 'glass' && !lit) {
            ctx.fillStyle = 'rgba(255,255,255,0.08)'
            ctx.fillRect(c * cw + cw * 0.15, r * rh + rh * 0.2, cw * 0.35, rh * 0.2)
          }
        }
      }
      if (style === 'brick') {
        ctx.strokeStyle = 'rgba(0,0,0,0.2)'
        for (let y = 0; y < size; y += 8) {
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(size, y)
          ctx.stroke()
        }
      }
    }, { size: 512, repeat: [1, 1] })
  }

  container(color: string): THREE.Texture {
    return this.get(`container:${color}`, (ctx, size, rng) => {
      ctx.fillStyle = color
      ctx.fillRect(0, 0, size, size)
      ctx.fillStyle = 'rgba(0,0,0,0.25)'
      for (let x = 0; x < size; x += size / 16) ctx.fillRect(x, 0, size / 48, size)
      ctx.fillStyle = 'rgba(255,255,255,0.15)'
      for (let i = 0; i < 60; i++) ctx.fillRect(rng() * size, rng() * size, rng() * 20, 3)
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.font = `bold ${size / 8}px sans-serif`
      ctx.fillText('APX', size * 0.1, size * 0.9)
    }, { size: 256 })
  }

  sprite(kind: 'smoke' | 'spark' | 'drop' | 'flake' | 'flare' | 'splash' | 'leaf'): THREE.Texture {
    return this.get(`sprite:${kind}`, (ctx, size, rng) => {
      ctx.clearRect(0, 0, size, size)
      const cx = size / 2
      if (kind === 'smoke' || kind === 'splash') {
        const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx)
        g.addColorStop(0, 'rgba(255,255,255,0.55)')
        g.addColorStop(0.45, 'rgba(255,255,255,0.25)')
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, size, size)
        // Break up the puff with blotches.
        for (let i = 0; i < 24; i++) {
          const r = size * (0.08 + rng() * 0.14)
          const x = cx + (rng() - 0.5) * size * 0.5
          const y = cx + (rng() - 0.5) * size * 0.5
          const g2 = ctx.createRadialGradient(x, y, 0, x, y, r)
          g2.addColorStop(0, 'rgba(255,255,255,0.35)')
          g2.addColorStop(1, 'rgba(255,255,255,0)')
          ctx.fillStyle = g2
          ctx.fillRect(0, 0, size, size)
        }
      } else if (kind === 'spark' || kind === 'flare') {
        const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx)
        g.addColorStop(0, 'rgba(255,255,255,1)')
        g.addColorStop(0.2, 'rgba(255,255,255,0.9)')
        g.addColorStop(0.5, 'rgba(255,255,255,0.25)')
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, size, size)
      } else if (kind === 'drop') {
        const g = ctx.createLinearGradient(0, 0, 0, size)
        g.addColorStop(0, 'rgba(255,255,255,0)')
        g.addColorStop(0.5, 'rgba(255,255,255,0.9)')
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.fillRect(size * 0.42, 0, size * 0.16, size)
      } else if (kind === 'flake') {
        ctx.fillStyle = 'rgba(255,255,255,1)'
        ctx.beginPath()
        ctx.arc(cx, cx, size * 0.3, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.fillStyle = 'rgba(255,255,255,1)'
        ctx.beginPath()
        ctx.ellipse(cx, cx, size * 0.2, size * 0.4, 0.6, 0, Math.PI * 2)
        ctx.fill()
      }
    }, { size: 128, wrap: false, fixedSize: true })
  }

  crowd(): THREE.Texture {
    return this.get('crowd', (ctx, size, rng) => {
      ctx.clearRect(0, 0, size, size)
      const cols = 8
      const w = size / cols
      for (let i = 0; i < cols; i++) {
        const x = i * w + w / 2
        const shirt = `hsl(${rng() * 360},70%,${45 + rng() * 25}%)`
        const skin = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'][Math.floor(rng() * 5)]
        ctx.fillStyle = skin
        ctx.beginPath()
        ctx.arc(x, size * 0.2, w * 0.18, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = shirt
        ctx.fillRect(x - w * 0.24, size * 0.3, w * 0.48, size * 0.35)
        ctx.fillStyle = '#20232b'
        ctx.fillRect(x - w * 0.2, size * 0.65, w * 0.16, size * 0.3)
        ctx.fillRect(x + w * 0.04, size * 0.65, w * 0.16, size * 0.3)
        if (rng() > 0.5) {
          ctx.fillStyle = shirt
          ctx.fillRect(x - w * 0.36, size * 0.1, w * 0.1, size * 0.3)
        }
      }
    }, { size: 512, wrap: false, fixedSize: true })
  }

  canopy(color: string): THREE.Texture {
    return this.get(`canopy:${color}`, (ctx, size, rng) => {
      ctx.clearRect(0, 0, size, size)
      const cx = size / 2
      for (let i = 0; i < 90; i++) {
        const r = size * (0.06 + rng() * 0.12)
        const a = rng() * Math.PI * 2
        const d = rng() * size * 0.33
        const x = cx + Math.cos(a) * d
        const y = cx + Math.sin(a) * d
        const c = hexToRgb(color)
        const k = 0.75 + rng() * 0.5
        ctx.fillStyle = `rgba(${c[0] * k},${c[1] * k},${c[2] * k},0.95)`
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      }
    }, { size: 256, wrap: false, fixedSize: true })
  }

  neonSign(text: string, color: string): THREE.Texture {
    return this.get(`neon:${text}:${color}`, (ctx, size) => {
      ctx.fillStyle = '#07060c'
      ctx.fillRect(0, 0, size, size)
      ctx.font = `bold ${size / 4}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.shadowColor = color
      ctx.shadowBlur = size / 12
      ctx.fillStyle = color
      for (let i = 0; i < 3; i++) ctx.fillText(text, size / 2, size / 2)
      ctx.shadowBlur = 0
      ctx.fillStyle = '#ffffff'
      ctx.fillText(text, size / 2, size / 2)
    }, { size: 256, wrap: false })
  }

  /** Plain light board for a billboard with no photo. */
  blankBoard(): THREE.Texture {
    return this.get('billboard:blank', (ctx, size) => {
      this.noiseFill(ctx, size, [214, 216, 214], 6, 3, 5)
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)'
      ctx.lineWidth = Math.max(2, size / 96)
      ctx.strokeRect(size * 0.03, size * 0.03, size * 0.94, size * 0.94)
    }, { size: 256, wrap: false })
  }

  /** Caption strip along the bottom of a billboard: light text on a dark band, 12:1. */
  caption(text: string): THREE.Texture {
    return this.get(`caption:${text}`, (ctx, size) => {
      const h = ctx.canvas.height
      ctx.fillStyle = '#111318'
      ctx.fillRect(0, 0, size, h)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
      ctx.fillRect(0, 0, size, Math.max(1, h * 0.04))
      let px = h * 0.7
      ctx.font = `700 ${px}px system-ui, "Helvetica Neue", Arial, sans-serif`
      let label = text
      while (ctx.measureText(label).width > size * 0.92 && px > h * 0.3) {
        px *= 0.9
        ctx.font = `700 ${px}px system-ui, "Helvetica Neue", Arial, sans-serif`
      }
      while (ctx.measureText(label).width > size * 0.92 && label.length > 4) label = label.slice(0, -2).trimEnd() + '…'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#f4f5f7'
      ctx.fillText(label, size / 2, h * 0.53)
    }, { size: 1024, height: 96, wrap: false, fixedSize: true })
  }

  plate(text: string): THREE.Texture {
    return this.get(`plate:${text}`, (ctx, size) => {
      const w = size
      const h = size / 4
      ctx.fillStyle = '#f5f5ef'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#1e3f9c'
      ctx.fillRect(0, 0, w * 0.1, h)
      ctx.fillStyle = '#ffd60a'
      ctx.font = `bold ${h * 0.35}px sans-serif`
      ctx.fillText('AX', w * 0.015, h * 0.6)
      ctx.fillStyle = '#111'
      ctx.font = `bold ${h * 0.6}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text.toUpperCase().slice(0, 8), w * 0.55, h * 0.52)
      ctx.strokeStyle = '#222'
      ctx.lineWidth = 4
      ctx.strokeRect(2, 2, w - 4, h - 4)
    }, { size: 512, wrap: false, fixedSize: true })
  }

  /** Body livery: paint + pattern + race number. UV: u along length, v around section. */
  livery(c: VehicleCustomization): THREE.Texture {
    const key = `livery:${c.paint}:${c.accent}:${c.livery}:${c.liveryColor}:${c.raceNumber}`
    return this.get(key, (ctx, size, rng) => {
      ctx.fillStyle = c.paint
      ctx.fillRect(0, 0, size, size)
      ctx.fillStyle = c.liveryColor
      const style: LiveryStyle = c.livery
      if (style === 'stripes') {
        ctx.fillRect(size * 0.44, 0, size * 0.05, size)
        ctx.fillRect(size * 0.51, 0, size * 0.05, size)
      } else if (style === 'racing') {
        ctx.fillRect(0, size * 0.3, size, size * 0.06)
        ctx.fillStyle = c.accent
        ctx.fillRect(0, size * 0.37, size, size * 0.03)
        ctx.fillRect(0, size * 0.6, size, size * 0.03)
        ctx.fillStyle = c.liveryColor
        ctx.fillRect(0, size * 0.64, size, size * 0.06)
      } else if (style === 'flames') {
        ctx.fillStyle = c.liveryColor
        for (let i = 0; i < 14; i++) {
          ctx.beginPath()
          const y = (i / 14) * size
          ctx.moveTo(0, y)
          ctx.quadraticCurveTo(size * 0.25, y + size * 0.02, size * (0.3 + rng() * 0.25), y + size * 0.035)
          ctx.quadraticCurveTo(size * 0.2, y + size * 0.05, 0, y + size * 0.07)
          ctx.fill()
        }
      } else if (style === 'camo') {
        const cols = [c.liveryColor, c.accent, shade(c.paint, 0.7)]
        for (let i = 0; i < 160; i++) {
          ctx.fillStyle = cols[i % 3]
          ctx.beginPath()
          ctx.ellipse(rng() * size, rng() * size, size * (0.03 + rng() * 0.08), size * (0.02 + rng() * 0.05), rng() * Math.PI, 0, Math.PI * 2)
          ctx.fill()
        }
      } else if (style === 'hex') {
        ctx.strokeStyle = c.liveryColor
        ctx.lineWidth = 3
        const r = size / 24
        for (let y = 0; y < size + r; y += r * 1.5) {
          for (let x = 0; x < size + r; x += r * 1.732) {
            const ox = ((y / (r * 1.5)) % 2) * r * 0.866
            ctx.beginPath()
            for (let k = 0; k < 6; k++) {
              const a = (k / 6) * Math.PI * 2 + Math.PI / 6
              const px = x + ox + Math.cos(a) * r * 0.9
              const py = y + Math.sin(a) * r * 0.9
              if (k === 0) ctx.moveTo(px, py)
              else ctx.lineTo(px, py)
            }
            ctx.closePath()
            ctx.globalAlpha = 0.25 + (x / size) * 0.6
            ctx.stroke()
          }
        }
        ctx.globalAlpha = 1
      } else if (style === 'splash') {
        for (let i = 0; i < 60; i++) {
          ctx.fillStyle = i % 2 ? c.liveryColor : c.accent
          ctx.globalAlpha = 0.6 + rng() * 0.4
          ctx.beginPath()
          ctx.arc(rng() * size, rng() * size, size * (0.01 + rng() * 0.05), 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.globalAlpha = 1
      } else if (style === 'carbon') {
        ctx.fillStyle = '#17181c'
        ctx.fillRect(0, 0, size, size)
        for (let y = 0; y < size; y += 6) {
          for (let x = 0; x < size; x += 6) {
            const k = ((x / 6 + y / 6) % 2) * 20 + 25
            ctx.fillStyle = `rgb(${k},${k},${k + 4})`
            ctx.fillRect(x, y, 5, 5)
          }
        }
        ctx.fillStyle = c.paint
        ctx.fillRect(0, size * 0.42, size, size * 0.16)
      } else if (style === 'retro') {
        ctx.fillStyle = c.liveryColor
        ctx.fillRect(0, size * 0.25, size, size * 0.1)
        ctx.fillStyle = c.accent
        ctx.fillRect(0, size * 0.36, size, size * 0.05)
        ctx.fillStyle = shade(c.liveryColor, 0.6)
        ctx.fillRect(0, size * 0.42, size, size * 0.1)
      }
      // Race number roundel on both flanks.
      if (style !== 'none') {
        for (const v of [0.22, 0.78]) {
          ctx.fillStyle = 'rgba(255,255,255,0.92)'
          ctx.beginPath()
          ctx.arc(size * 0.55, size * v, size * 0.07, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = '#111'
          ctx.font = `bold ${size * 0.09}px sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(c.raceNumber), size * 0.55, size * v + 2)
        }
      }
    }, { size: 1024, wrap: false })
  }

  water(): THREE.Texture {
    return this.get('water', (ctx, size) => {
      this.noiseFill(ctx, size, [128, 128, 255], 40, 10, 11)
    }, { size: 256, repeat: [30, 30], srgb: false })
  }

  dispose(): void {
    this.releaseAll()
  }
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function shade(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex)
  const c = (v: number) => clampByte(v * k).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}
