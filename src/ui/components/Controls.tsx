/**
 * Small form primitives shared by the option, garage and setup screens.
 */

import type { ReactNode } from 'react'

export function Panel({ title, children, className = '', tight = false }: { title?: string; children: ReactNode; className?: string; tight?: boolean }) {
  return (
    <div className={`panel ${tight ? 'panel--tight' : ''} ${className}`}>
      {title && <h3 className="panel__title">{title}</h3>}
      {children}
    </div>
  )
}

export function Segmented<T extends string | number>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: string; disabled?: boolean }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={String(o.value)} className={`segmented__opt ${o.value === value ? 'segmented__opt--on' : ''}`} disabled={disabled || o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, value, children }: { label: string; value?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field__label">
        <span>{label}</span>
        {value !== undefined && <b>{value}</b>}
      </div>
      {children}
    </div>
  )
}

export function Slider({ value, min, max, step = 0.01, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className={`toggle ${value ? 'toggle--on' : ''}`} onClick={() => onChange(!value)}>
      <span className="toggle__track" />
      <span>{label}</span>
    </label>
  )
}

export function StatBar({ label, value, max = 100, delta = 0, display }: { label: string; value: number; max?: number; delta?: number; display?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  const deltaPct = Math.max(0, Math.min(100 - pct, (delta / max) * 100))
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <div className="stat__bar" style={{ display: 'flex' }}>
        <div className="stat__fill" style={{ width: `${pct}%` }} />
        {deltaPct > 0 && <div className="stat__fill stat__fill--delta" style={{ width: `${deltaPct}%` }} />}
      </div>
      <span className="stat__value">{display ?? Math.round(value)}</span>
    </div>
  )
}

export function Chip({ children, tone }: { children: ReactNode; tone?: 'accent' | 'gold' }) {
  return <span className={`chip ${tone ? `chip--${tone}` : ''}`}>{children}</span>
}
