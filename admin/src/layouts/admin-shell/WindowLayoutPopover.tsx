import { type RefObject } from 'react'
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
}: WindowLayoutPopoverProps) => (
  <Popover
    anchorRef={anchorRef}
    className="desktop-window-layout-popover"
    label="Window layouts"
    onClose={onClose}
    open={open}
    placement="bottom-start"
    style={{ marginLeft: -27, marginTop: 20 }}
  >
    <div
      className="desktop-window-layout-content"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      {windowLayoutSections.map((section, sectionIndex) => (
        <section
          aria-label={section.label}
          className="desktop-window-layout-section"
          key={section.label}
        >
          {sectionIndex > 0 ? <div className="desktop-window-layout-divider" /> : null}
          <h2>{section.label}</h2>
          <div className="desktop-window-layout-grid">
            {section.options.map((option) => (
              <button
                aria-label={option.label}
                className="desktop-window-layout-option"
                key={option.layout}
                onClick={() => onLayout(option.layout)}
                title={option.label}
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
        <span>Full screen</span>
        <span aria-hidden="true">›</span>
      </button>
    </div>
  </Popover>
)
