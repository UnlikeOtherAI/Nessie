import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { faChevronDown, faUser, faUserSlash, faUsers } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useTranslation } from 'react-i18next'
import { PROVIDER_LABEL } from '../../../../facades/board-sources/hooks'
import type { AssignableUser } from '../../../../facades/tasks/hooks'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { Popover } from '../../../overlays/Popover'
import { IdentityTile } from '../../../primitives/IdentityTile'
import { UserAvatar } from '../../../shared/UserAvatar'
import type { AssigneeFilter, RemoteAssigneeOption } from './board-assignee-filter'

type BoardAssigneeFilterProps = {
  value: AssigneeFilter
  onChange: (next: AssigneeFilter) => void
  people: AssignableUser[]
  remote: RemoteAssigneeOption[]
  /** Absent while the session is still loading; "My issues" waits for it. */
  currentUserId: string | null
  /**
   * Draw the trigger as one 44px mark — the selected person's avatar, or the
   * filter's glyph — with the name left to the accessible name and the
   * description. For the single-column header, where the row has to hold the
   * title as well; the picker itself is unchanged.
   */
  compact?: boolean
}

type StaticChoice = {
  icon: typeof faUser
  key: 'allAssignees' | 'unassigned' | 'myIssues'
  value: Extract<AssigneeFilter, 'all' | 'me' | 'unassigned'>
}

const allAssigneesChoice: StaticChoice = { icon: faUsers, key: 'allAssignees', value: 'all' }
const unassignedChoice: StaticChoice = { icon: faUser, key: 'unassigned', value: 'unassigned' }
const initialChoices: StaticChoice[] = [allAssigneesChoice, unassignedChoice]

const RemoteAssigneeAvatar = ({ label, size }: { label: string; size: number }) => (
  <IdentityTile
    background="var(--panel-soft)"
    color="var(--tx2)"
    fallback={{ kind: 'icon', icon: <FontAwesomeIcon icon={faUserSlash} /> }}
    imageUrl={null}
    label={label}
    size={size}
  />
)

const optionClassName = (highlighted: boolean, selected: boolean): string => [
  'flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
  highlighted ? 'bg-[color:var(--overlay)]' : 'hover:bg-[color:var(--main-hover)]',
  selected ? 'text-[color:var(--tx)]' : 'text-[color:var(--tx2)]',
].join(' ')

/**
 * Narrow the board to one person's cards without flattening provider people
 * into the project roster. The listbox uses the shared popover so it follows
 * the anchor on scroll, flips at the viewport edge, and closes through the
 * navigation overlay lifecycle.
 */
export const BoardAssigneeFilter = ({
  value,
  onChange,
  people,
  remote,
  currentUserId,
  compact = false,
}: BoardAssigneeFilterProps) => {
  const { t } = useTranslation('projects')
  const { token } = useAuthSession()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const listboxId = useId()

  const staticChoices = useMemo<StaticChoice[]>(
    () => currentUserId
      ? [
          allAssigneesChoice,
          { icon: faUser, key: 'myIssues', value: 'me' },
          unassignedChoice,
        ]
      : initialChoices,
    [currentUserId],
  )
  const term = query.trim().toLocaleLowerCase()
  const matchingStatic = useMemo(
    () => term ? staticChoices.filter((choice) => t(`board.assigneeFilter.${choice.key}`).toLocaleLowerCase().includes(term)) : staticChoices,
    [staticChoices, term, t],
  )
  const matchingPeople = useMemo(
    () => term ? people.filter((person) => person.displayName.toLocaleLowerCase().includes(term)) : people,
    [people, term],
  )
  const matchingRemote = useMemo(
    () => term ? remote.filter((person) => person.label.toLocaleLowerCase().includes(term)) : remote,
    [remote, term],
  )
  const optionValues = useMemo(
    () => [
      ...matchingStatic.map((choice) => choice.value),
      ...matchingPeople.map((person) => `user:${person.id}`),
      ...matchingRemote.map((person) => person.value),
    ],
    [matchingPeople, matchingRemote, matchingStatic],
  )
  const selectedPerson = people.find((person) => value === `user:${person.id}`)
  const selectedRemote = remote.find((person) => value === person.value)
  const selectedStatic = staticChoices.find((choice) => value === choice.value)

  useEffect(() => {
    if (!open) return undefined
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  const openPicker = () => {
    setQuery('')
    setHighlighted(0)
    setOpen(true)
  }

  const close = (restoreFocus = false) => {
    if (restoreFocus) {
      // The trigger remains mounted while this popover closes. Restore focus
      // now: queueing it can steal focus from a fast re-opened search field.
      triggerRef.current?.focus()
    }
    setOpen(false)
  }

  const choose = (next: AssigneeFilter) => {
    onChange(next)
    close(true)
  }

  const focusOption = (index: number) => {
    const next = optionValues[index]
    if (!next) return
    setHighlighted(index)
    optionRefs.current.get(next)?.focus()
  }

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close(true)
      return
    }

    if (event.key === 'Enter' && event.target === inputRef.current) {
      event.preventDefault()
      const next = optionValues[highlighted]
      if (next) choose(next as AssigneeFilter)
      return
    }

    if (event.target === inputRef.current && ['Home', 'End'].includes(event.key)) return
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLButtonElement>('[data-board-assignee-option]')
      : null
    const currentIndex = target ? optionValues.indexOf(target.value) : highlighted
    if (event.key === 'Home') {
      focusOption(0)
    } else if (event.key === 'End') {
      focusOption(optionValues.length - 1)
    } else if (event.key === 'ArrowDown') {
      focusOption(Math.min(currentIndex + 1, optionValues.length - 1))
    } else {
      focusOption(Math.max(currentIndex - 1, 0))
    }
  }

  const selectedContent = selectedPerson ? (
    <>
      <UserAvatar displayName={selectedPerson.displayName} size={24} token={token} userId={selectedPerson.id} />
      <span className="truncate">{selectedPerson.displayName}</span>
    </>
  ) : selectedRemote ? (
    <>
      <RemoteAssigneeAvatar label={`${selectedRemote.label} — ${t('board.assigneeFilter.notMapped')}`} size={24} />
      <span className="min-w-0 flex-1 truncate" title={selectedRemote.label}>
        {selectedRemote.label}
      </span>
    </>
  ) : (
    <>
      <FontAwesomeIcon className="w-4 shrink-0 text-[color:var(--tx3)]" icon={selectedStatic?.icon ?? faUsers} />
      <span className="truncate">{(selectedStatic ? t(`board.assigneeFilter.${selectedStatic.key}`) : t('board.assigneeFilter.allAssignees'))}</span>
    </>
  )

  const selectedMark = selectedPerson ? (
    <UserAvatar displayName={selectedPerson.displayName} size={24} token={token} userId={selectedPerson.id} />
  ) : selectedRemote ? (
    <RemoteAssigneeAvatar label={`${selectedRemote.label} — ${t('board.assigneeFilter.notMapped')}`} size={24} />
  ) : (
    <FontAwesomeIcon className="w-4 text-[color:var(--tx3)]" icon={selectedStatic?.icon ?? faUsers} />
  )

  const selectedLabel = selectedPerson?.displayName
    ?? selectedRemote?.label
    ?? (selectedStatic ? t(`board.assigneeFilter.${selectedStatic.key}`) : t('board.assigneeFilter.allAssignees'))

  const selectedTextId = `${listboxId}-selected`

  return (
    <div
      className={compact ? 'w-fit' : 'w-fit max-w-[min(20rem,100%)]'}
      data-board-assignee-filter
    >
      <button
        aria-controls={open ? listboxId : undefined}
        aria-describedby={selectedTextId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={t('board.assigneeFilter.label')}
        // `admin-page-custom-action` is what keeps this on the header's line:
        // it stands in the action row, so it takes the action height from the
        // same token rather than `admin-input`'s own 44px padding box. The
        // compact form is a square at that height, as a compact action is.
        className={
          compact
            ? 'admin-input admin-page-custom-action flex w-[var(--page-header-action-height)] items-center justify-center p-0'
            : 'admin-input admin-page-custom-action flex w-full items-center gap-2 text-left'
        }
        onClick={() => {
          if (open) close()
          else openPicker()
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            openPicker()
          }
        }}
        ref={triggerRef}
        type="button"
      >
        {/* Compact keeps the mark and moves the name out of the box rather
            than dropping it: `aria-describedby` still points here, so the
            trigger is announced as the person it is filtered to. */}
        <span
          className={
            compact
              ? 'sr-only'
              : 'flex min-w-0 flex-1 items-center gap-2'
          }
          id={selectedTextId}
        >
          {compact ? selectedLabel : selectedContent}
        </span>
        {compact ? (
          <span aria-hidden="true" className="flex items-center justify-center">
            {selectedMark}
          </span>
        ) : (
          <FontAwesomeIcon className="shrink-0 text-[10px] text-[color:var(--tx3)]" icon={faChevronDown} />
        )}
      </button>

      <Popover
        anchorRef={triggerRef}
        className="flex w-[min(20rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] shadow-lg"
        label={t('board.assigneeFilter.label')}
        onClose={() => close()}
        onKeyDown={onListKeyDown}
        open={open}
        placement="bottom-start"
        role="dialog"
      >
        <div className="shrink-0 border-b border-[color:var(--sep)] p-2">
          <input
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={t('board.assigneeFilter.search')}
            className="admin-input min-h-11"
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlighted(0)
            }}
            placeholder={t('board.assigneeFilter.searchPlaceholder')}
            ref={inputRef}
            role="combobox"
            value={query}
          />
        </div>
        <div aria-label={t('board.assigneeFilter.label')} className="min-h-0 overflow-y-auto py-1" id={listboxId} role="listbox">
          {matchingStatic.map((choice, index) => (
            <button
              aria-selected={value === choice.value}
              className={optionClassName(highlighted === index, value === choice.value)}
              data-board-assignee-option
              key={choice.value}
              onClick={() => choose(choice.value)}
              onMouseEnter={() => setHighlighted(index)}
              ref={(node) => {
                if (node) optionRefs.current.set(choice.value, node)
                else optionRefs.current.delete(choice.value)
              }}
              role="option"
              type="button"
              value={choice.value}
            >
              <FontAwesomeIcon className="w-4 shrink-0 text-[color:var(--tx3)]" icon={choice.icon} />
              <span className="truncate">{t(`board.assigneeFilter.${choice.key}`)}</span>
            </button>
          ))}

          {matchingPeople.length > 0 ? (
            <div aria-label={t('board.assigneeFilter.people')} className="border-t border-[color:var(--sep)] pt-1" role="group">
              <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]">
                {t('board.assigneeFilter.people')}
              </div>
              {matchingPeople.map((person) => {
                const optionValue = `user:${person.id}` as AssigneeFilter
                const index = optionValues.indexOf(optionValue)
                return (
                  <button
                    aria-selected={value === optionValue}
                    className={optionClassName(highlighted === index, value === optionValue)}
                    data-board-assignee-option
                    key={person.id}
                    onClick={() => choose(optionValue)}
                    onMouseEnter={() => setHighlighted(index)}
                    ref={(node) => {
                      if (node) optionRefs.current.set(optionValue, node)
                      else optionRefs.current.delete(optionValue)
                    }}
                    role="option"
                    type="button"
                    value={optionValue}
                  >
                    <UserAvatar displayName={person.displayName} size={28} token={token} userId={person.id} />
                    <span className="truncate">{person.displayName}</span>
                  </button>
                )
              })}
            </div>
          ) : null}

          {matchingRemote.length > 0 ? (
            <div aria-label={t('board.assigneeFilter.notMapped')} className="border-t border-[color:var(--sep)] pt-1" role="group">
              <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]">
                {t('board.assigneeFilter.notMapped')}
              </div>
              {matchingRemote.map((person) => {
                const index = optionValues.indexOf(person.value)
                return (
                  <button
                    aria-selected={value === person.value}
                    className={optionClassName(highlighted === index, value === person.value)}
                    data-board-assignee-option
                    key={person.value}
                    onClick={() => choose(person.value)}
                    onMouseEnter={() => setHighlighted(index)}
                    ref={(node) => {
                      if (node) optionRefs.current.set(person.value, node)
                      else optionRefs.current.delete(person.value)
                    }}
                    role="option"
                    type="button"
                    value={person.value}
                  >
                    <RemoteAssigneeAvatar label={`${person.label} — ${t('board.assigneeFilter.notMapped')}`} size={28} />
                    <span className="min-w-0 flex-1 truncate">{person.label}</span>
                    <span className="shrink-0 text-xs text-[color:var(--tx3)]">
                      {t('board.assigneeFilter.notMapped')} · {PROVIDER_LABEL[person.provider]}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}

          {term && matchingPeople.length === 0 && matchingRemote.length === 0 ? (
            <p className="px-3 py-3 text-sm text-[color:var(--tx3)]">{t('board.assigneeFilter.noMatches')}</p>
          ) : null}
        </div>
      </Popover>
    </div>
  )
}
