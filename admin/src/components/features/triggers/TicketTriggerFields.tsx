import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { TICKET_TRIGGER_LIMIT_CEILINGS } from '@nessie/schemas'

import { useProjectBoards } from '../../../facades/boards/hooks'
import { PROVIDER_LABEL, useProjectSources } from '../../../facades/board-sources/hooks'
import { Checkbox } from '../../primitives/Checkbox'
import { Switch } from '../../primitives/Switch'
import { CATEGORY_LABEL } from '../projects/kanban/kanban-config'
import { fieldLabelClass, type TriggerFormState } from './trigger-config'
import { TriggerFieldError, TriggerFieldSection } from './TriggerFieldParts'
import {
  columnEndsWork,
  getDefaultTicketState,
  TICKET_FOLLOW_KIND_OPTIONS,
  TICKET_INSTRUCTION_SECTIONS,
  TICKET_INSTRUCTIONS_EXAMPLE,
  type TicketFieldErrors,
  type TicketFormField,
  type TicketInstructionSection,
  type TicketTriggerFormState,
} from './ticket-trigger-form'

/**
 * The `ticket_changed` fields of the Triggers editor
 * (docs/standards/ticket-work.md). Columns are picked, not typed; a server
 * refusal lands on the field it names. It says what never starts work — an
 * agent's, a token's or a connected board's move — because a person looking
 * at an empty chip otherwise has no way to learn why.
 */

type TicketTriggerFieldsProps = {
  errors: TicketFieldErrors
  form: TriggerFormState
  /** The project of the chosen channel: the only project whose boards this trigger may work. */
  projectId: string | null
  setForm: Dispatch<SetStateAction<TriggerFormState>>
}

const FieldError = ({ field, message }: { field: TicketFormField; message?: string }) =>
  <TriggerFieldError field={field} message={message} />

const Section = TriggerFieldSection

/** A board's In progress columns: where a board's work usually starts, so a new trigger starts there. */
const startColumnsOf = (board: { columns: { category: string; id: string }[] } | undefined): string[] =>
  (board?.columns ?? []).filter((column) => column.category === 'in_progress').map((column) => column.id)

export const TicketTriggerFields = ({ errors, form, projectId, setForm }: TicketTriggerFieldsProps) => {
  const ticket = form.ticket ?? getDefaultTicketState()
  const { data: boards = [] } = useProjectBoards(projectId ?? undefined)
  const board = boards.find((candidate) => candidate.id === ticket.boardId)
  const { data: sources = [] } = useProjectSources(projectId ?? undefined, board?.id)
  const mirrored = sources.map((source) => PROVIDER_LABEL[source.provider])

  const patch = (next: Partial<TicketTriggerFormState>) =>
    setForm((current) => ({ ...current, ticket: { ...(current.ticket ?? getDefaultTicketState()), ...next } }))
  const toggle = <T extends string>(list: readonly T[], value: T, on: boolean): T[] =>
    on ? [...new Set([...list, value])] : list.filter((entry) => entry !== value)

  // A board from another project, or none yet: the project's default board.
  useEffect(() => {
    if (boards.length === 0 || boards.some((candidate) => candidate.id === ticket.boardId)) return
    const fallback = boards.find((candidate) => candidate.isDefault) ?? boards[0]
    if (!fallback) return
    setForm((current) => ({
      ...current,
      ticket: {
        ...(current.ticket ?? getDefaultTicketState()),
        boardId: fallback.id,
        endOnColumnIds: [],
        pickupColumnIds: startColumnsOf(fallback),
      },
    }))
  }, [boards, setForm, ticket.boardId])

  const columns = board?.columns ?? []
  const setInstruction = (key: TicketInstructionSection, value: string) =>
    patch({ instructions: { ...ticket.instructions, [key]: value } })
  const [shown, folded] = [TICKET_INSTRUCTION_SECTIONS.slice(0, 3), TICKET_INSTRUCTION_SECTIONS.slice(3)]
  const instructionField = ({ hint, key, label }: (typeof TICKET_INSTRUCTION_SECTIONS)[number]) => (
    <div className="grid gap-1" key={key}>
      <label className="text-sm font-medium text-[color:var(--tx2)]" htmlFor={`ticket-instructions-${key}`}>
        {label}
        {key === 'general' ? null : <span className="font-normal text-[color:var(--tx3)]"> (optional)</span>}
      </label>
      <textarea
        className="admin-input min-h-16"
        id={`ticket-instructions-${key}`}
        onChange={(event) => setInstruction(key, event.target.value)}
        placeholder={TICKET_INSTRUCTIONS_EXAMPLE[key] ?? hint}
        value={ticket.instructions[key]}
      />
      <p className="text-xs text-[color:var(--tx3)]">{hint}</p>
    </div>
  )

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="grid gap-1.5 md:col-span-2">
        <label className={fieldLabelClass} htmlFor="ticket-trigger-board">Board</label>
        <select
          className="admin-input"
          id="ticket-trigger-board"
          onChange={(event) => patch({
            boardId: event.target.value,
            endOnColumnIds: [],
            pickupColumnIds: startColumnsOf(boards.find((candidate) => candidate.id === event.target.value)),
          })}
          value={ticket.boardId}
        >
          {boards.length === 0 ? <option value="">This channel’s project has no board yet</option> : null}
          {boards.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
          ))}
        </select>
        <FieldError field="boardId" message={errors.boardId} />
      </div>

      <Section
        hint="A person who can edit the board moving a ticket into one of these starts work. A move by an agent, an API token or a connected board never does."
        title="Start work when a ticket enters"
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {columns.map((column) => {
            const ends = columnEndsWork(ticket, column)
            return (
              <Checkbox
                checked={ticket.pickupColumnIds.includes(column.id)}
                description={ends
                  ? 'Ends the work, so it cannot start it'
                  // The category, when the name does not already say it.
                  : column.name.trim().toLowerCase() === CATEGORY_LABEL[column.category].toLowerCase()
                    ? undefined
                    : CATEGORY_LABEL[column.category]}
                disabled={ends && !ticket.pickupColumnIds.includes(column.id)}
                key={column.id}
                label={column.name}
                onChange={(on) => patch({ pickupColumnIds: toggle(ticket.pickupColumnIds, column.id, on) })}
              />
            )
          })}
        </div>
        {ticket.pickupColumnIds.length === 0 ? (
          <p className="text-xs text-[color:var(--tx3)]">No column picked: this trigger only follows work, and starts none.</p>
        ) : null}
        <label className="flex items-center gap-2 text-sm text-[color:var(--tx2)]">
          <Switch
            checked={ticket.assignOnPickup}
            label="Assign the ticket to the agent when work starts"
            onChange={(next) => patch({ assignOnPickup: next })}
          />
          Assign an unassigned ticket to the agent when work starts
        </label>
        <FieldError field="pickup" message={errors.pickup} />
      </Section>

      <Section hint="Only while its work is live, and only for changes a person who can edit the board makes." title="Wake the agent on">
        <div className="grid gap-2 sm:grid-cols-2">
          {TICKET_FOLLOW_KIND_OPTIONS.map(({ kind, label }) => (
            <Checkbox
              checked={ticket.followKinds.includes(kind)}
              key={kind}
              label={label}
              onChange={(on) => patch({ followKinds: toggle(ticket.followKinds, kind, on) })}
            />
          ))}
        </div>
        <Checkbox
          checked={ticket.includeSourceEvents}
          description="A change made on the connected board itself never starts or resumes work. With this on it can wake work that is already live, and its text reaches the agent marked as untrusted."
          label="Also wake on a connected board’s own changes"
          onChange={(next) => patch({ includeSourceEvents: next })}
        />
        {mirrored.length > 0 ? (
          <p className="text-xs text-[color:var(--tx3)]" data-testid="ticket-trigger-mirrored">
            This board mirrors {mirrored.join(', ')}. A ticket moved there never starts work here; only a person
            moving it on this board does.
          </p>
        ) : null}
        <FieldError field="follow" message={errors.follow} />
      </Section>

      <Section hint="The platform ends the work in the same step as the move, whoever made it." title="Work ends when a ticket enters">
        <div className="grid gap-2 sm:grid-cols-2">
          <Checkbox checked={ticket.endOnTodo} label="Any To do column" onChange={(next) => patch({ endOnTodo: next })} />
          <Checkbox checked={ticket.endOnDone} label="Any Done column" onChange={(next) => patch({ endOnDone: next })} />
          {columns
            .filter((column) => column.category === 'in_progress' || column.category === 'review')
            .map((column) => (
              <Checkbox
                checked={ticket.endOnColumnIds.includes(column.id)}
                disabled={ticket.pickupColumnIds.includes(column.id)}
                key={column.id}
                label={column.name}
                onChange={(on) => patch({ endOnColumnIds: toggle(ticket.endOnColumnIds, column.id, on) })}
              />
            ))}
        </div>
        <FieldError field="endOn" message={errors.endOn} />
      </Section>

      <Section title="Limits">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm text-[color:var(--tx2)]" htmlFor="ticket-trigger-wakes">
            Wakes per ticket
            <input
              className="admin-input"
              id="ticket-trigger-wakes"
              inputMode="numeric"
              max={TICKET_TRIGGER_LIMIT_CEILINGS.wakesPerTicket}
              min={1}
              onChange={(event) => patch({ wakesPerTicket: event.target.value })}
              type="number"
              value={ticket.wakesPerTicket}
            />
          </label>
          <label className="grid gap-1 text-sm text-[color:var(--tx2)]" htmlFor="ticket-trigger-starts">
            Tickets started per day
            <input
              className="admin-input"
              id="ticket-trigger-starts"
              inputMode="numeric"
              max={TICKET_TRIGGER_LIMIT_CEILINGS.startsPerDay}
              min={1}
              onChange={(event) => patch({ startsPerDay: event.target.value })}
              type="number"
              value={ticket.startsPerDay}
            />
          </label>
        </div>
        <p className="text-xs text-[color:var(--tx3)]">
          When a ticket uses its wakes the work stops; a person restarts it by moving the ticket out of and back
          into a start-work column.
        </p>
        <FieldError field="limits" message={errors.limits} />
      </Section>

      <Section
        hint="Every wake shows the first section, then the one that matches why the agent woke."
        title="Instructions"
      >
        {shown.map(instructionField)}
        <details className="grid gap-3">
          <summary className="cursor-pointer select-none text-xs font-semibold text-[color:var(--tx3)] hover:text-[color:var(--tx2)]">
            More sections
          </summary>
          <div className="mt-2 grid gap-3">{folded.map(instructionField)}</div>
        </details>
        <div>
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            onClick={() => patch({
              instructions: Object.fromEntries(Object.entries(ticket.instructions).map(([key, value]) => [
                key,
                value.trim() ? value : TICKET_INSTRUCTIONS_EXAMPLE[key as TicketInstructionSection] ?? '',
              ])) as TicketTriggerFormState['instructions'],
            })}
            type="button"
          >
            Fill empty sections with the example
          </button>
        </div>
        <FieldError field="instructions" message={errors.instructions} />
      </Section>
    </div>
  )
}
