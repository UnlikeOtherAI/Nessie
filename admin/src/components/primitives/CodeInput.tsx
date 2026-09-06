import { useCallback, useEffect, useId, useMemo, useRef, type ClipboardEvent, type KeyboardEvent } from 'react'

/**
 * A short code, one character per box.
 *
 * A pairing code is read off one screen and typed into another, so the shape
 * should tell you how much is left and where you are. One long text field does
 * neither, and it invites the transcription mistakes the code's own alphabet
 * was chosen to avoid.
 *
 * The behaviours that actually decide whether this is usable:
 *
 * - **Paste fills the whole code, from any box.** People copy the code rather
 *   than read it, and a segmented input that takes only the first character of
 *   a paste is worse than a plain field. Separators and case in the pasted text
 *   are ignored, so `wxyz-2345`, `WXYZ 2345` and `wxyz2345` all work.
 * - **Typing advances, deleting retreats.** Backspace in an empty box moves to
 *   the previous one and clears it, which is what every other code input in the
 *   world does and therefore what fingers expect.
 * - **It is still one field to a screen reader.** Each box is labelled with its
 *   position and the group carries the real label, rather than presenting as
 *   eight unexplained textboxes.
 */

export type CodeInputProps = {
  /** Where the dash goes. `4` renders `••••-••••`. */
  groupSize?: number
  label: string
  length?: number
  onChange: (value: string) => void
  /** Fired when the last box is filled, so a caller can submit without a click. */
  onComplete?: (value: string) => void
  /** Uppercase alphanumerics only, matching the codes the server mints. */
  value: string
}

const sanitize = (raw: string, length: number): string =>
  raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, length)

export const CodeInput = ({
  groupSize = 4,
  label,
  length = 8,
  onChange,
  onComplete,
  value,
}: CodeInputProps) => {
  const groupId = useId()
  const inputs = useRef<Array<HTMLInputElement | null>>([])
  const characters = useMemo(
    () => Array.from({ length }, (_, index) => value[index] ?? ''),
    [length, value],
  )

  const focusBox = useCallback((index: number) => {
    inputs.current[Math.max(0, Math.min(index, length - 1))]?.focus()
  }, [length])

  // Announced once the code is whole, so a caller can act without the person
  // hunting for a button.
  useEffect(() => {
    if (value.length === length) onComplete?.(value)
  }, [length, onComplete, value])

  const setAt = (index: number, character: string) => {
    const next = characters.slice()
    next[index] = character
    onChange(next.join('').slice(0, length))
  }

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    // The reason this component exists rather than eight bare inputs: a paste
    // has to land as a whole code, wherever the caret happens to be.
    const pasted = sanitize(event.clipboardData.getData('text'), length)
    if (pasted.length === 0) return
    event.preventDefault()
    onChange(pasted)
    focusBox(pasted.length)
  }

  const handleKeyDown = (index: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      event.preventDefault()
      if (characters[index]) {
        setAt(index, '')
        return
      }
      // Empty box: step back and clear that one, which is what the finger meant.
      const previous = index - 1
      if (previous >= 0) {
        setAt(previous, '')
        focusBox(previous)
      }
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusBox(index - 1)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusBox(index + 1)
    }
  }

  return (
    <div aria-labelledby={`${groupId}-label`} className="grid gap-1.5" role="group">
      <span className="sr-only" id={`${groupId}-label`}>{label}</span>
      <div className="flex items-center gap-1.5">
        {characters.map((character, index) => (
          <span className="contents" key={index}>
            <input
              aria-label={`${label}, character ${index + 1} of ${length}`}
              autoComplete={index === 0 ? 'one-time-code' : 'off'}
              className={[
                'h-11 w-9 rounded-lg border text-center text-base font-medium uppercase',
                'border-[var(--bd)] bg-[var(--bg2)] text-[var(--tx)]',
                'focus:border-[var(--accent)] focus:outline-none focus:ring-1',
                'focus:ring-[var(--accent)]',
              ].join(' ')}
              inputMode="text"
              maxLength={1}
              onChange={(event) => {
                const next = sanitize(event.target.value, 1)
                if (!next) return
                setAt(index, next)
                focusBox(index + 1)
              }}
              onFocus={(event) => event.target.select()}
              onKeyDown={handleKeyDown(index)}
              onPaste={handlePaste}
              ref={(element) => {
                inputs.current[index] = element
              }}
              spellCheck={false}
              value={character}
            />
            {groupSize > 0 && index === groupSize - 1 && index < length - 1 ? (
              <span aria-hidden="true" className="px-0.5 text-[color:var(--tx3)]">
                –
              </span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  )
}
