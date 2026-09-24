import {
  STANDING_POLICY_ANY_COMMAND_OPTION,
  STANDING_POLICY_LIMIT_CEILINGS,
  STANDING_POLICY_LIMIT_DEFAULTS,
  type PreparedStandingPolicyResponse,
  type StandingPolicyMachineOption,
} from '@nessie/schemas'
import { useMemo, useState } from 'react'

import { formErrorMessage } from '../../../facades/forms/form-errors'
import { usePrepareStandingPolicy, useStandingPolicyMachines } from '../../../facades/standing-policies/hooks'
import { Checkbox } from '../../primitives/Checkbox'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { Input } from '../../shared/FormControls'
import { FormField } from '../../shared/FormField'
import { QueryState } from '../../shared/QueryState'
import {
  machineOptionFacts,
  machineOptionRefusal,
  sharedCodingRoots,
  type MachineAccessChoices,
} from './machine-access-presentation'

/**
 * The author's own setup of a ticket trigger's machine access
 * (docs/standards/ticket-work-machine-access.md → "What the screens show"):
 * one or two of their private machines, each refused with its reason when it
 * cannot take the work with the options chosen; the coding folders they all
 * share; the separate "run any command" tick; and the policy's limits, with
 * each machine's per-turn budget held to the ticket's. Submitting prepares
 * the one card, which the section then shows for the author to review and
 * confirm with their password. The server checks every choice again.
 */

type Limits = { dailyUsd: string; ticketHours: string; ticketUsd: string }

const number = (value: string): number => (value.trim() === '' ? Number.NaN : Number(value))

const limitError = (value: string, ceiling: number, unit: string): string | undefined => {
  const parsed = number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 'Enter a number above zero.'
  return parsed > ceiling ? `At most ${ceiling} ${unit}.` : undefined
}

type RefusedMachine = { label?: string; sentence?: string }

const machineRefusalsOf = (error: unknown): RefusedMachine[] => {
  const details = (error as { details?: { machines?: unknown } } | null)?.details
  return Array.isArray(details?.machines) ? details.machines as RefusedMachine[] : []
}

export const MachineAccessSetupDialog = ({
  onClose,
  onPrepared,
  open,
  triggerId,
}: {
  onClose: () => void
  onPrepared: (prepared: PreparedStandingPolicyResponse) => void
  open: boolean
  triggerId: string
}) => {
  const machinesQuery = useStandingPolicyMachines(triggerId, open)
  const prepare = usePrepareStandingPolicy(triggerId)
  const [selected, setSelected] = useState<string[]>([])
  const [allowAnyCommand, setAllowAnyCommand] = useState(false)
  const [excludedRoots, setExcludedRoots] = useState<string[]>([])
  const [limits, setLimits] = useState<Limits>({
    dailyUsd: String(STANDING_POLICY_LIMIT_DEFAULTS.dailyUsd),
    ticketHours: String(STANDING_POLICY_LIMIT_DEFAULTS.ticketHours),
    ticketUsd: String(STANDING_POLICY_LIMIT_DEFAULTS.ticketUsd),
  })
  const machines = useMemo(() => machinesQuery.data?.machines ?? [], [machinesQuery.data])
  const chosen = machines.filter((machine) => selected.includes(machine.executorId))
  const roots = sharedCodingRoots(chosen)
  const allowedRoots = roots.filter((root) => !excludedRoots.includes(root))
  const choices: MachineAccessChoices = {
    allowAnyCommand,
    roots: allowedRoots,
    ticketUsd: number(limits.ticketUsd) || STANDING_POLICY_LIMIT_DEFAULTS.ticketUsd,
  }
  const errors = {
    dailyUsd: limitError(limits.dailyUsd, STANDING_POLICY_LIMIT_CEILINGS.dailyUsd, 'dollars a day'),
    ticketHours: limitError(limits.ticketHours, STANDING_POLICY_LIMIT_CEILINGS.ticketHours, 'hours'),
    ticketUsd: limitError(limits.ticketUsd, STANDING_POLICY_LIMIT_CEILINGS.ticketUsd, 'dollars'),
  }
  const refusalOf = (machine: StandingPolicyMachineOption) => machineOptionRefusal(machine, choices)
  const blocked = chosen.some((machine) => refusalOf(machine) !== null)
  const invalid = selected.length === 0 || allowedRoots.length === 0 || blocked
    || Object.values(errors).some(Boolean)
  const refusedByServer = machineRefusalsOf(prepare.error)

  const toggleMachine = (executorId: string, on: boolean) => setSelected((current) => (
    on
      ? [...current.filter((id) => id !== executorId), executorId].slice(-2)
      : current.filter((id) => id !== executorId)
  ))

  const submit = () => {
    if (invalid) return
    prepare.mutate({
      allowAnyCommand,
      allowedRootNames: allowedRoots,
      executorIds: selected,
      limits: {
        dailyUsd: number(limits.dailyUsd), ticketHours: number(limits.ticketHours), ticketUsd: number(limits.ticketUsd),
      },
    }, { onSuccess: (prepared) => onPrepared(prepared) })
  }

  return (
    <Dialog
      description="Your own machines, as you: pick one or two, then review the one card that says what you agree to."
      dismissDisabled={prepare.isPending}
      onClose={onClose}
      open={open}
      size="lg"
      title="Set up machine access"
    >
      <QueryState
        className="py-6"
        emptyLabel="You have paired no private machine in this organisation. Pair one from Executors first."
        errorLabel="Your machines could not be loaded."
        isEmpty={machines.length === 0}
        loadingLabel="Loading your machines…"
        query={machinesQuery}
      >
        {() => (
          <div className="grid gap-4" data-testid="machine-access-form">
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-xs font-medium text-[color:var(--tx2)]">Machines (one or two)</legend>
              {machines.map((machine) => {
                const refusal = refusalOf(machine)
                const checked = selected.includes(machine.executorId)
                return (
                  <div className="grid gap-1" data-testid="machine-option" key={machine.executorId}>
                    <Checkbox
                      checked={checked}
                      description={machineOptionFacts(machine) ?? undefined}
                      disabled={machine.refusal !== null && !checked}
                      label={machine.label}
                      onChange={(on) => toggleMachine(machine.executorId, on)}
                    />
                    {refusal ? (
                      <p className="ml-6 text-xs text-[var(--danger-text)]" data-testid="machine-refusal">{refusal}</p>
                    ) : null}
                  </div>
                )
              })}
            </fieldset>

            {roots.length > 0 ? (
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-xs font-medium text-[color:var(--tx2)]">Coding folders tickets may use</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {roots.map((root) => (
                    <Checkbox
                      checked={!excludedRoots.includes(root)}
                      key={root}
                      label={root}
                      onChange={(on) => setExcludedRoots((current) => (
                        on ? current.filter((entry) => entry !== root) : [...current, root]))}
                    />
                  ))}
                </div>
                {allowedRoots.length === 0 ? <FormError>Leave at least one folder.</FormError> : null}
              </fieldset>
            ) : chosen.length > 0 ? (
              <FormError>The machines you picked share no coding folder, so no ticket could start on both.</FormError>
            ) : null}

            <Checkbox
              checked={allowAnyCommand}
              description={'Only for a machine whose Claude Code runs every command without asking '
                + '(bypassPermissions, or a Bash rule that allows every command). The people who can edit the '
                + 'board could then have it run anything on your machine, as you.'}
              label={STANDING_POLICY_ANY_COMMAND_OPTION}
              onChange={setAllowAnyCommand}
            />

            <div className="grid gap-3 sm:grid-cols-3">
              <FormField error={errors.ticketHours} help="Not counting time it waits." label="Hours per ticket">
                <Input inputMode="decimal" onChange={(event) => setLimits({ ...limits, ticketHours: event.target.value })}
                  value={limits.ticketHours} />
              </FormField>
              <FormField error={errors.ticketUsd} help="Each machine’s per-turn budget must fit." label="Dollars per ticket">
                <Input inputMode="decimal" onChange={(event) => setLimits({ ...limits, ticketUsd: event.target.value })}
                  value={limits.ticketUsd} />
              </FormField>
              <FormField error={errors.dailyUsd} help="All of this trigger’s tickets." label="Dollars per day">
                <Input inputMode="decimal" onChange={(event) => setLimits({ ...limits, dailyUsd: event.target.value })}
                  value={limits.dailyUsd} />
              </FormField>
            </div>

            {refusedByServer.length > 0 ? (
              <FormError>{refusedByServer.map((machine) => machine.sentence).filter(Boolean).join(' ')}</FormError>
            ) : prepare.error ? <FormError>{formErrorMessage(prepare.error, 'Machine access could not be prepared. Try again.')}</FormError> : null}
            <FormActions>
              <button className="admin-button admin-button-secondary" disabled={prepare.isPending} onClick={onClose} type="button">
                Cancel
              </button>
              <button
                className="admin-button admin-button-primary"
                disabled={invalid || prepare.isPending}
                onClick={submit}
                type="button"
              >
                {prepare.isPending ? 'Preparing…' : 'Prepare the card'}
              </button>
            </FormActions>
          </div>
        )}
      </QueryState>
    </Dialog>
  )
}
