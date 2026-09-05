import { useEffect, useState } from 'react'
import {
  PROVIDER_LABEL,
  useProjectSource,
  usePutSourceMappings,
  useUpdateProjectSource,
  type BoardSourceFieldMapping,
  type BoardSourceStateMapping,
  type BoardSourceWriteMode,
} from '../../../facades/board-sources/hooks'
import { useTaskAssignees } from '../../../facades/tasks/hooks'
import { useTaskFields } from '../../../facades/task-fields/hooks'
import { ChoiceGroup } from '../../../components/shared/ChoiceGroup'
import { Select } from '../../../components/shared/FormControls'
import { Section } from '../../../components/shared/PageBody'
import { CATEGORY_LABEL, CATEGORY_ORDER } from '../../../components/kanban/kanban-config'

type SourceMappingPanelProps = {
  canAdminister: boolean
  onSaveError: (message: string) => void
  onSaved: () => void
  projectId: string
  sourceId: string
}

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Not mapped' },
  ...CATEGORY_ORDER.map((category) => ({ value: category, label: CATEGORY_LABEL[category] })),
  { value: 'archived', label: 'Archived' },
]

/**
 * What this source's states, fields and people mean here.
 *
 * The whole document is sent at once rather than merged field by field: the
 * three tables are interdependent — a state's default decides where a write-back
 * goes — and a partial merge of them is a merge nobody can reason about.
 */
export const SourceMappingPanel = ({
  canAdminister,
  onSaveError,
  onSaved,
  projectId,
  sourceId,
}: SourceMappingPanelProps) => {
  const { data: source } = useProjectSource(projectId, sourceId)
  const { data: assignees = [] } = useTaskAssignees()
  const { data: definitions = [] } = useTaskFields(projectId)
  const putMappings = usePutSourceMappings(projectId)
  const updateSource = useUpdateProjectSource(projectId)

  const [stateMapping, setStateMapping] = useState<BoardSourceStateMapping[]>([])
  const [fieldMappings, setFieldMappings] = useState<BoardSourceFieldMapping[]>([])
  const [identity, setIdentity] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!source) return
    setStateMapping(source.stateMapping)
    setFieldMappings(source.fieldMappings)
    setIdentity(
      Object.fromEntries(
        source.identityLinks
          .filter((link) => link.userId)
          .map((link) => [link.externalUserId, link.userId as string]),
      ),
    )
  }, [source])

  if (!source) return null

  const save = (
    next: BoardSourceStateMapping[],
    people: Record<string, string>,
    fields: BoardSourceFieldMapping[] = fieldMappings,
  ) => {
    putMappings.mutate(
      {
        id: sourceId,
        stateMapping: next,
        fieldMappings: fields,
        identityLinks: source.members.map((member) => ({
          externalUserId: member.externalUserId,
          externalDisplayName: member.displayName,
          userId: people[member.externalUserId] ?? null,
        })),
      },
      {
        onError: (cause) =>
          onSaveError(cause instanceof Error ? cause.message : 'Could not save the mapping'),
        onSuccess: onSaved,
      },
    )
  }

  const setCategory = (externalStateId: string, value: string) => {
    const next = stateMapping.map((entry) =>
      entry.externalStateId === externalStateId
        ? {
            ...entry,
            category: (value === '' ? null : value) as BoardSourceStateMapping['category'],
            // A state that stops being mapped cannot be the default for a
            // category it no longer belongs to.
            isDefaultForCategory: value === '' ? false : entry.isDefaultForCategory,
          }
        : entry,
    )
    setStateMapping(next)
    save(next, identity)
  }

  const setDefault = (externalStateId: string) => {
    const target = stateMapping.find((entry) => entry.externalStateId === externalStateId)
    if (!target || target.category === null || target.category === 'archived') return
    const next = stateMapping.map((entry) => ({
      ...entry,
      isDefaultForCategory:
        entry.category === target.category
          ? entry.externalStateId === externalStateId
          : entry.isDefaultForCategory,
    }))
    setStateMapping(next)
    save(next, identity)
  }

  const setPerson = (externalUserId: string, userId: string) => {
    const next = { ...identity, [externalUserId]: userId }
    setIdentity(next)
    save(stateMapping, next)
  }

  return (
    <>
      <Section
        description={`How ${PROVIDER_LABEL[source.provider]}'s states land on this project's boards. Review starts empty everywhere — a state's name is not evidence of what it means, so somebody promotes it deliberately.`}
        title="States"
      >
        <div className="grid gap-2">
          {stateMapping.map((entry) => (
            <div className="flex items-center gap-2" key={entry.externalStateId}>
              <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]">
                {entry.externalStateName}
              </span>
              <Select
                aria-label={`Category for ${entry.externalStateName}`}
                className="max-w-[180px]"
                disabled={!canAdminister}
                onChange={(event) => setCategory(entry.externalStateId, event.target.value)}
                size="compact"
                value={entry.category ?? ''}
              >
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <label className="flex items-center gap-1.5 text-xs text-[color:var(--tx3)]">
                <input
                  checked={entry.isDefaultForCategory}
                  disabled={
                    !canAdminister || entry.category === null || entry.category === 'archived'
                  }
                  name={`default-${entry.category ?? 'none'}`}
                  onChange={() => setDefault(entry.externalStateId)}
                  type="radio"
                />
                Default
              </label>
            </div>
          ))}
          {stateMapping.length === 0 ? (
            <div className="text-sm text-[color:var(--tx3)]">
              Waiting for the first sync to read this container&rsquo;s states.
            </div>
          ) : null}
        </div>
      </Section>

      <Section
        description={`Where each ${PROVIDER_LABEL[source.provider]} field lands. Seeded on connect from what the container actually has; a field set to "Not imported" is left alone on both sides.`}
        title="Fields"
      >
        <div className="grid gap-2">
          {source.fields.map((field) => {
            const mapped = fieldMappings.find((entry) => entry.externalKey === field.key)
            return (
              <div className="flex items-center gap-2" key={field.key}>
                <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]">
                  {field.label}
                  <span className="ml-2 text-xs text-[color:var(--tx3)]">{field.type}</span>
                </span>
                <Select
                  aria-label={`Target for ${field.label}`}
                  className="max-w-[240px]"
                  disabled={!canAdminister}
                  onChange={(event) => {
                    const target = event.target.value
                    const next = [
                      ...fieldMappings.filter((entry) => entry.externalKey !== field.key),
                      ...(target
                        ? [
                            {
                              externalKey: field.key,
                              externalLabel: field.label,
                              target,
                            } as BoardSourceFieldMapping,
                          ]
                        : []),
                    ]
                    setFieldMappings(next)
                    save(stateMapping, identity, next)
                  }}
                  size="compact"
                  value={mapped?.target ?? ''}
                >
                  <option value="">Not imported</option>
                  <option value="native:priority">Priority</option>
                  <option value="native:dueDate">Deadline</option>
                  <option value="native:storyPoints">Story points</option>
                  <option value="native:detail">Detail</option>
                  {definitions.map((definition) => (
                    <option key={definition.id} value={`field:${definition.id}`}>
                      {definition.name}
                    </option>
                  ))}
                </Select>
              </div>
            )
          })}
          {source.fields.length === 0 ? (
            <div className="text-sm text-[color:var(--tx3)]">
              Waiting for the first sync to read this container&rsquo;s fields.
            </div>
          ) : null}
        </div>
      </Section>

      <Section
        description="Who upstream is who here. Auto-matched by exact email where the provider exposes one; everything else is chosen."
        title="People"
      >
        <div className="grid gap-2">
          {source.members.map((member) => (
            <div className="flex items-center gap-2" key={member.externalUserId}>
              <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]">
                {member.displayName}
              </span>
              <Select
                aria-label={`Nessie identity for ${member.displayName}`}
                className="max-w-[220px]"
                disabled={!canAdminister}
                onChange={(event) => setPerson(member.externalUserId, event.target.value)}
                size="compact"
                value={identity[member.externalUserId] ?? ''}
              >
                <option value="">Not linked</option>
                {assignees.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </Select>
            </div>
          ))}
          {source.members.length === 0 ? (
            <div className="text-sm text-[color:var(--tx3)]">
              Waiting for the first sync to read this container&rsquo;s members.
            </div>
          ) : null}
        </div>
      </Section>

      <Section
        description={
          source.writeMode === 'read_only'
            ? `Read only: ${PROVIDER_LABEL[source.provider]} decides. Moving a card here that would change its stage is refused.`
            : `Read & write: moving a card here moves it in ${PROVIDER_LABEL[source.provider]}, under ${source.connectionOwnerDisplayName ?? 'the connection owner'}'s account.`
        }
        title="Write mode"
      >
        <ChoiceGroup
          label="Write mode"
          labelHidden
          onChange={(writeMode: BoardSourceWriteMode) =>
            updateSource.mutate(
              { id: sourceId, writeMode },
              {
                onError: (cause) =>
                  onSaveError(
                    cause instanceof Error ? cause.message : 'Could not change the write mode',
                  ),
                onSuccess: onSaved,
              },
            )
          }
          options={[
            { label: 'Read only', value: 'read_only' },
            { label: 'Read & write', value: 'read_write' },
          ]}
          value={source.writeMode}
        />
      </Section>
    </>
  )
}

