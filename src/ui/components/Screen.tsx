import type { ReactNode } from 'react'
import { Button } from './Button'
import { navigate, type Screen as ScreenId } from '../../game/state/GameStore'

export function Screen({ title, subtitle, back = 'menu', children, footer, overlay = true, actions }: { title: string; subtitle?: string; back?: ScreenId | null; children: ReactNode; footer?: ReactNode; overlay?: boolean; actions?: ReactNode }) {
  return (
    <div className={`screen ${overlay ? 'screen--overlay' : ''}`}>
      <div className="screen__header">
        {back && (
          <Button variant="ghost" size="small" sound="back" onClick={() => navigate(back)}>
            ◀ Back
          </Button>
        )}
        <div>
          <h1 className="screen__title">{title}</h1>
          {subtitle && <div className="screen__subtitle">{subtitle}</div>}
        </div>
        <div className="spacer" />
        {actions}
      </div>
      <div className="screen__body">{children}</div>
      {footer && <div className="screen__footer">{footer}</div>}
    </div>
  )
}
