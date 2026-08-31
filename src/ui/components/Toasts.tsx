import { useGameStore } from '../../game/state/GameStore'

export function Toasts() {
  const toasts = useGameStore((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.icon && <span>{t.icon}</span>}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}
