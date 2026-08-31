/**
 * Photo mode capture: grabs the current WebGL frame, down-scales it for
 * storage and stores the latest shots on the profile (cap keeps localStorage
 * bounded). Also offers a browser download.
 */

import { saveManager } from '../persistence/SaveManager'
import { bus } from '../core/EventBus'

export const MAX_STORED_PHOTOS = 12

export function captureFrame(canvas: HTMLCanvasElement, maxWidth = 1280, quality = 0.86): string {
  const scale = Math.min(1, maxWidth / canvas.width)
  const w = Math.round(canvas.width * scale)
  const h = Math.round(canvas.height * scale)
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')
  if (!ctx) return canvas.toDataURL('image/jpeg', quality)
  ctx.drawImage(canvas, 0, 0, w, h)
  // Watermark.
  ctx.font = `bold ${Math.round(h * 0.028)}px sans-serif`
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  ctx.textAlign = 'right'
  ctx.fillText('APEX OVERDRIVE', w - 18, h - 16)
  return out.toDataURL('image/jpeg', quality)
}

export function storePhoto(dataUrl: string): void {
  saveManager.update((p) => {
    p.photos.unshift(dataUrl)
    if (p.photos.length > MAX_STORED_PHOTOS) p.photos.length = MAX_STORED_PHOTOS
  })
  bus.emit('photo:captured', { dataUrl })
}

export function downloadPhoto(dataUrl: string, name = `apex-overdrive-${Date.now()}.jpg`): void {
  try {
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (err) {
    console.warn('[Photo] download failed', err)
  }
}
