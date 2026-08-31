import { memo } from 'react'

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  const [x0, y0] = p(a0)
  const [x1, y1] = p(a1)
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`
}

export const Speedometer = memo(function Speedometer({ speedKmh, rpm, redline, gear, limiter, units, nitroActive }: { speedKmh: number; rpm: number; redline: number; gear: number; limiter: boolean; units: 'kmh' | 'mph'; nitroActive: boolean }) {
  const start = Math.PI * 0.75
  const end = Math.PI * 2.25
  const rpmT = Math.min(1, rpm / redline)
  const speedMax = 360
  const speedT = Math.min(1, speedKmh / speedMax)
  const cx = 125
  const cy = 110
  const rOuter = 100
  const rInner = 84
  const rpmEnd = start + (end - start) * rpmT
  const speedEnd = start + (end - start) * speedT
  const gearLabel = gear === 0 ? 'N' : gear < 0 ? 'R' : String(gear)
  const shown = units === 'mph' ? Math.round(speedKmh * 0.621371) : Math.round(speedKmh)
  const ticks = []
  for (let i = 0; i <= 12; i++) {
    const a = start + ((end - start) * i) / 12
    const r0 = rOuter + 4
    const r1 = rOuter + (i % 3 === 0 ? 12 : 8)
    ticks.push(<line key={i} x1={cx + r0 * Math.cos(a)} y1={cy + r0 * Math.sin(a)} x2={cx + r1 * Math.cos(a)} y2={cy + r1 * Math.sin(a)} stroke={i >= 10 ? '#ff4d5e' : 'rgba(255,255,255,0.5)'} strokeWidth={i % 3 === 0 ? 2.5 : 1.5} />)
  }
  return (
    <div className="speedo">
      <svg viewBox="0 0 250 170">
        <defs>
          <linearGradient id="rpmGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#7ef0ff" />
            <stop offset="0.7" stopColor="#ffd60a" />
            <stop offset="1" stopColor="#ff4d5e" />
          </linearGradient>
          <linearGradient id="spdGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#ff6a00" />
          </linearGradient>
        </defs>
        <path d={arc(cx, cy, rOuter, start, end)} stroke="rgba(255,255,255,0.12)" strokeWidth="10" fill="none" strokeLinecap="round" />
        <path d={arc(cx, cy, rOuter, start, Math.max(start + 0.001, rpmEnd))} stroke={limiter ? '#ff4d5e' : 'url(#rpmGrad)'} strokeWidth="10" fill="none" strokeLinecap="round" style={{ filter: rpmT > 0.9 ? 'drop-shadow(0 0 6px #ff4d5e)' : undefined }} />
        <path d={arc(cx, cy, rInner, start, end)} stroke="rgba(255,255,255,0.08)" strokeWidth="5" fill="none" strokeLinecap="round" />
        <path d={arc(cx, cy, rInner, start, Math.max(start + 0.001, speedEnd))} stroke={nitroActive ? '#7ef0ff' : 'url(#spdGrad)'} strokeWidth="5" fill="none" strokeLinecap="round" />
        {ticks}
        <text x={cx} y={cy + 40} textAnchor="middle" fill="rgba(255,255,255,0.55)" fontSize="9" letterSpacing="3">
          RPM ×1000 · {Math.round(redline / 1000)}
        </text>
      </svg>
      <div className="speedo__speed">{shown}</div>
      <div className="speedo__unit">{units === 'mph' ? 'MPH' : 'KM/H'}</div>
      <div className={`speedo__gear ${limiter ? 'speedo__gear--limiter' : ''}`}>{gearLabel}</div>
    </div>
  )
})
