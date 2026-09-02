import { useState } from 'react'

/**
 * The boundary a person writes for their assistant.
 *
 * Free text, judged by a model on every action — never parsed. A rule builder
 * with keyword fields could not honour a boundary written in one language about
 * mail written in another, and that is the project's standing rule on intent.
 * The presets below are starter *text*, editable in place: they fill the box,
 * they are not rules.
 */

export const BOUNDARY_PRESETS: { label: string; text: string }[] = [
  {
    label: 'Routine only',
    text:
      'Handle scheduling, confirmations, and replies on internal threads '
      + 'yourself. Ask me before anything going to a customer or anyone new.',
  },
  {
    label: 'Everything except commitments',
    text:
      'Send freely, but ask me before anything involving money, deadlines, '
      + 'promises, or saying no to someone.',
  },
  {
    label: 'Scheduling only',
    text:
      'Only send meeting invitations and time proposals yourself. Ask me about '
      + 'all other email.',
  },
]

export const SendBoundaryEditor = ({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (next: string) => void
  disabled?: boolean
}) => {
  const [touched, setTouched] = useState(false)

  return (
    <div className="mt-2" data-testid="send-boundary-editor">
      <div className="flex flex-wrap gap-1.5">
        {BOUNDARY_PRESETS.map((preset) => (
          <button
            className="rounded border border-[color:var(--sep)] px-2 py-1 text-[11px] text-[color:var(--tx2)]"
            disabled={disabled}
            key={preset.label}
            onClick={() => {
              setTouched(true)
              onChange(preset.text)
            }}
            type="button"
          >
            {preset.label}
          </button>
        ))}
      </div>
      <textarea
        aria-label="What you are happy for your assistant to decide"
        className="mt-2 h-24 w-full rounded border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-2 text-xs leading-5 text-[color:var(--tx)]"
        disabled={disabled}
        onChange={(event) => {
          setTouched(true)
          onChange(event.target.value)
        }}
        placeholder="Handle the routine ones yourself. Ask me before anything going outside the company."
        value={value}
      />
      <p className="mt-1 text-[11px] leading-4 text-[color:var(--tx3)]">
        Write it the way you would brief a person. Any language works. When your
        assistant is not sure, it asks.
      </p>
      {touched && value.trim().length === 0 ? (
        <p className="mt-1 text-[11px] text-[color:var(--danger-text)]">
          Deciding for you needs a note saying what you are happy with.
        </p>
      ) : null}
    </div>
  )
}
