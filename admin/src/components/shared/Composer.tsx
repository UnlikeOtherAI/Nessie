import type { FormEventHandler, ReactNode } from 'react'

type ComposerProps = {
  action?: ReactNode
  buttonLabel: string
  children: ReactNode
  onSubmit: FormEventHandler<HTMLFormElement>
}

export const Composer = ({ action, buttonLabel, children, onSubmit }: ComposerProps) => (
  <form className="rounded-[1.75rem] border border-[color:var(--line)] bg-white/75 p-4" onSubmit={onSubmit}>
    <div className="grid gap-3">{children}</div>
    <div className="mt-4 flex items-center justify-between gap-3">
      {action ?? <span />}
      <button
        className="rounded-2xl bg-[color:var(--accent)] px-4 py-3 text-sm font-medium text-white"
        type="submit"
      >
        {buttonLabel}
      </button>
    </div>
  </form>
)
