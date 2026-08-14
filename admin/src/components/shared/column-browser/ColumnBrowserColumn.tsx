import type { ReactNode } from 'react'
import { usePhoneLayout } from '../../../lib/mobile-shell'
import { PhoneBackButton } from '../../../layouts/admin-shell/PhoneBackButton'
import { PhoneNavigationButton } from '../../../layouts/admin-shell/PhoneNavigationButton'
import {
  columnBackPriority,
  useColumnBackContext,
  useLocalBack,
} from '../../../layouts/admin-shell/local-back/LocalBackContext'

type ColumnBrowserColumnProps = {
  children: ReactNode
  headerAction?: ReactNode
  leading?: ReactNode
  onBack?: () => void
  // True when this column owns a Back action at all — independent of layout.
  // Wider layouts paint the shared circular Back beside the title; on a phone
  // the column instead registers its unwind action with the shell's local-back
  // registry, and only the viewport-visible column's registration is active
  // (retained off-screen columns stay mounted for the slide transition but
  // must never hold the doorway). Deeper columns outrank shallower ones via
  // their viewport index, so Back always unwinds exactly one level.
  showBack?: boolean
  title: string
}

export const ColumnBrowserColumn = ({
  children,
  headerAction,
  leading,
  onBack,
  showBack,
  title,
}: ColumnBrowserColumnProps) => {
  const phoneLayout = usePhoneLayout()
  const { index, phoneVisible } = useColumnBackContext()
  const backLabel = `Back from ${title}`
  useLocalBack({
    active: phoneLayout && phoneVisible && Boolean(showBack && onBack),
    id: `column:${index ?? 'standalone'}:${title}`,
    label: backLabel,
    onBack: onBack ?? (() => undefined),
    priority: columnBackPriority(index ?? 0),
  })

  return (
    <div className="flex h-full flex-col border-r border-[color:var(--sep)] bg-[color:var(--main)]">
      <div className="flex h-[50px] flex-shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4">
        {leading}
        {showBack && onBack
          ? phoneLayout
            ? phoneVisible
              ? <PhoneNavigationButton />
              : null
            : <PhoneBackButton label={backLabel} onBack={onBack} />
          : null}
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[color:var(--tx)]">
          {title}
        </h3>
        {headerAction}
      </div>
      <div className="flex-1 overflow-y-auto p-3">{children}</div>
    </div>
  )
}
