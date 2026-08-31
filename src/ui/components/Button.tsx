import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Engine } from '../../game/core/Engine'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'menu'
  size?: 'small' | 'normal' | 'big'
  icon?: ReactNode
  sub?: ReactNode
  sound?: 'click' | 'back' | 'success' | 'purchase' | 'none'
}

export function Button({ variant = 'default', size = 'normal', icon, sub, sound = 'click', className = '', children, onClick, onMouseEnter, ...rest }: Props) {
  const cls = ['btn', variant !== 'default' ? `btn--${variant}` : '', size !== 'normal' ? `btn--${size}` : '', className].filter(Boolean).join(' ')
  return (
    <button
      className={cls}
      onMouseEnter={(e) => {
        try {
          Engine.get().audio?.playUI('hover')
        } catch {
          /* engine not ready */
        }
        onMouseEnter?.(e)
      }}
      onClick={(e) => {
        try {
          if (sound !== 'none') Engine.get().audio?.playUI(sound)
        } catch {
          /* engine not ready */
        }
        onClick?.(e)
      }}
      {...rest}
    >
      {icon && <span className="btn__icon">{icon}</span>}
      <span>{children}</span>
      {sub && <span className="btn__sub">{sub}</span>}
    </button>
  )
}
