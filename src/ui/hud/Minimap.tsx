import { memo, useEffect, useRef } from 'react'
import type { MinimapData } from '../../game/tracks/TrackBuilder'
import type { MinimapCar } from '../../game/state/GameStore'

export const Minimap = memo(function Minimap({ data, cars, progress }: { data: MinimapData | null; cars: MinimapCar[]; progress: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !data) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const size = canvas.clientWidth
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr
      canvas.height = size * dpr
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)
    const b = data.bounds
    const w = b.maxX - b.minX
    const h = b.maxZ - b.minZ
    const scale = (size - 24) / Math.max(w, h)
    const ox = (size - w * scale) / 2
    const oz = (size - h * scale) / 2
    const px = (x: number) => ox + (x - b.minX) * scale
    const pz = (z: number) => size - (oz + (z - b.minZ) * scale)
    // Shortcuts.
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const sc of data.shortcuts) {
      ctx.beginPath()
      sc.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), pz(z)) : ctx.moveTo(px(x), pz(z))))
      ctx.strokeStyle = 'rgba(255,214,10,0.55)'
      ctx.lineWidth = 2
      ctx.setLineDash([3, 3])
      ctx.stroke()
      ctx.setLineDash([])
    }
    // Track outline.
    ctx.beginPath()
    data.points.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), pz(z)) : ctx.moveTo(px(x), pz(z))))
    if (data.points.length > 2 && Math.hypot(data.points[0][0] - data.points[data.points.length - 1][0], data.points[0][1] - data.points[data.points.length - 1][1]) < 60) ctx.closePath()
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 4
    ctx.stroke()
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'
    ctx.lineWidth = 1.5
    ctx.stroke()
    // Start.
    ctx.fillStyle = '#fff'
    ctx.fillRect(px(data.startPoint[0]) - 3, pz(data.startPoint[1]) - 3, 6, 6)
    // Cars.
    for (const c of cars) {
      if (c.isPlayer) continue
      ctx.beginPath()
      ctx.arc(px(c.x), pz(c.z), 3, 0, Math.PI * 2)
      ctx.fillStyle = c.color
      ctx.fill()
    }
    const p = cars.find((c) => c.isPlayer)
    if (p) {
      ctx.save()
      ctx.translate(px(p.x), pz(p.z))
      ctx.rotate(-p.yaw)
      ctx.beginPath()
      ctx.moveTo(0, -7)
      ctx.lineTo(5, 5)
      ctx.lineTo(0, 3)
      ctx.lineTo(-5, 5)
      ctx.closePath()
      ctx.fillStyle = '#ff6a00'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.restore()
    }
    void progress
  }, [data, cars, progress])
  return <canvas ref={ref} className="minimap" />
})
