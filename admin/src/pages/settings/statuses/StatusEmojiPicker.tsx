import { useId, useRef, useState } from 'react'
import { faChevronDown, faCircleXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Popover } from '../../../components/overlays/Popover'
import { EmojiPickerPanel } from '../../../components/shared/EmojiPickerPanel'
import { useFormFieldControl } from '../../../components/shared/FormField'

type StatusEmojiPickerProps = {
  label: string
  onChange: (value: string) => void
  value: string
}

export const StatusEmojiPicker = ({ label, onChange, value }: StatusEmojiPickerProps) => {
  const [open, setOpen] = useState(false)
  const pickerId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  // The field's own id / describedBy / invalid wiring, so the trigger reads as
  // the form control it stands for. Dismissal — outside press, Escape, the
  // layer — is `Popover`'s, never a second listener here.
  const field = useFormFieldControl()

  const pick = (nextValue: string) => {
    onChange(nextValue)
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        aria-controls={open ? pickerId : undefined}
        aria-describedby={field?.describedBy}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-invalid={field?.invalid || undefined}
        aria-label={label}
        className="admin-input flex items-center justify-between gap-2 text-left"
        id={field?.id}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >
        <span
          className={
            value
              ? 'text-lg leading-none text-[color:var(--tx)]'
              : 'truncate text-[color:var(--tx3)]'
          }
        >
          {value || 'Icon'}
        </span>
        <FontAwesomeIcon
          className="shrink-0 text-[10px] text-[color:var(--tx3)]"
          icon={faChevronDown}
        />
      </button>
      <Popover
        anchorRef={triggerRef}
        className="w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-2 shadow-lg"
        id={pickerId}
        label={label}
        onClose={() => setOpen(false)}
        open={open}
        placement="bottom-start"
      >
        <div className="mb-2 flex justify-end">
          <button
            aria-label="Clear icon"
            className={[
              'flex h-8 w-8 items-center justify-center rounded text-sm',
              'text-[color:var(--tx3)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
              value ? '' : 'bg-[color:var(--accent-soft)] text-[color:var(--tx)]',
            ].join(' ')}
            onClick={() => pick('')}
            title="Clear icon"
            type="button"
          >
            <FontAwesomeIcon icon={faCircleXmark} />
          </button>
        </div>
        <EmojiPickerPanel onSelect={pick} />
      </Popover>
    </div>
  )
}
