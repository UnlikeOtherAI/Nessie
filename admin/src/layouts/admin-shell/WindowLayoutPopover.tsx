import { type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover } from '../../components/overlays/Popover'
import {
  windowLayoutSections,
  type WindowLayout,
} from './window-layouts'

type WindowLayoutPopoverProps = {
  anchorRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onFullScreen: () => void
  onLayout: (layout: WindowLayout) => void
  onPointerEnter: () => void
  onPointerLeave: () => void
  open: boolean
}

const LayoutGlyph = ({ layout }: { layout: WindowLayout }) => (
  <span aria-hidden="true" className={`desktop-window-layout-glyph desktop-window-layout-glyph--${layout}`}>
    <span />
  </span>
)

// A shared Popover gives the hover panel the shell's consistent layer,
// positioning, Escape handling and outside-dismissal rather than creating a
// second overlay model just for native window chrome.
export const WindowLayoutPopover = ({
  anchorRef,
  onClose,
  onFullScreen,
  onLayout,
  onPointerEnter,
  onPointerLeave,
  open,
}: WindowLayoutPopoverProps) => {
  const { t } = useTranslation('shell')
  const layoutLabels: Record<WindowLayout, string> = {
    'bottom-half': t('window.bottomHalf'),
    fill: t('window.fillScreen'),
    'left-half': t('window.leftHalf'),
    'left-third': t('window.leftThird'),
    'middle-third': t('window.middleThird'),
    'right-half': t('window.rightHalf'),
    'right-third': t('window.rightThird'),
    'top-half': t('window.topHalf'),
  }
  return (
  <Popover
    anchorRef={anchorRef}
    className="desktop-window-layout-popover"
    label={t('window.layouts')}
    onClose={onClose}
    open={open}
    placement="bottom-start"
    style={{ marginLeft: -27, marginTop: 36 }}
  >
    <div
      className="desktop-window-layout-content"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      {windowLayoutSections.map((section, sectionIndex) => (
        <section
          aria-label={section.id === 'moveResize' ? t('window.moveResize') : t('window.fillArrange')}
          className="desktop-window-layout-section"
          key={section.id}
        >
          {sectionIndex > 0 ? <div className="desktop-window-layout-divider" /> : null}
          <h2>{section.id === 'moveResize' ? t('window.moveResize') : t('window.fillArrange')}</h2>
          <div className="desktop-window-layout-grid">
            {section.options.map((option) => (
              <button
                aria-label={layoutLabels[option.layout]}
                className="desktop-window-layout-option"
                key={option.layout}
                onClick={() => onLayout(option.layout)}
                title={layoutLabels[option.layout]}
                type="button"
              >
                <LayoutGlyph layout={option.layout} />
              </button>
            ))}
          </div>
        </section>
      ))}

      <div className="desktop-window-layout-divider" />
      <button
        className="desktop-window-layout-full-screen"
        onClick={onFullScreen}
        type="button"
      >
        <span>{t('window.fullScreen')}</span>
        <span aria-hidden="true">›</span>
      </button>
    </div>
  </Popover>
  )
}
