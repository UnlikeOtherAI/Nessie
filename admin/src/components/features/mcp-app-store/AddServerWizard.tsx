import type { CreateCatalogEntryInput } from '../../../facades/mcp-catalog/hooks'
import { useAddServerWizard } from './use-add-server-wizard'
import { StepTransport } from './add-server-wizard-step-transport'
import { StepIdentity } from './add-server-wizard-step-identity'
import { StepAuth } from './add-server-wizard-step-auth'

/**
 * "Add MCP server" wizard. Three steps: transport, catalog identity, auth
 * method. State lives in `useAddServerWizard`; each step renders from
 * `./add-server-wizard-step-*`. On the final step it calls `onSubmit` with a
 * typed `CreateCatalogEntryInput`; the hosting page runs the mutation.
 */

type AddServerWizardProps = {
  onCancel: () => void
  onSubmit: (
    input: CreateCatalogEntryInput,
    options: { submitForReview: boolean },
  ) => Promise<void>
  pending?: boolean
}

export const AddServerWizard = ({
  onCancel,
  onSubmit,
  pending = false,
}: AddServerWizardProps) => {
  const controller = useAddServerWizard(onSubmit)
  const { step } = controller

  return (
    <form className="grid gap-5" onSubmit={(event) => void controller.submit(event)}>
      <ol className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[color:var(--tx3)]">
        {(['transport', 'identity', 'auth'] as const).map((value, index) => (
          <li
            className={[
              'rounded-full px-3 py-1',
              step === value
                ? 'bg-[color:var(--accent)] text-[var(--on-accent)]'
                : 'border border-[color:var(--sep)]',
            ].join(' ')}
            key={value}
          >
            {index + 1}. {value}
          </li>
        ))}
      </ol>

      {step === 'transport' && (
        <StepTransport controller={controller} onCancel={onCancel} />
      )}
      {step === 'identity' && <StepIdentity controller={controller} />}
      {step === 'auth' && (
        <StepAuth controller={controller} pending={pending} />
      )}
    </form>
  )
}
