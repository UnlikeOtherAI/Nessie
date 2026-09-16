import { useRef, useState } from 'react'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgePageShareAccess, KnowledgePageShareRecord } from '@nessie/schemas'
import { toFormErrors } from '../../../../facades/forms/form-errors'
import { useUsers } from '../../../../facades/users/hooks'
import { useTeamMembers } from '../../../../facades/users/team-members'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { ChoiceGroup } from '../../../shared/ChoiceGroup'
import { Dialog } from '../../../shared/Dialog'
import { FormError } from '../../../shared/FormActions'
import { Popover } from '../../../overlays/Popover'
import { PersonPicker, type PersonOption } from '../../../shared/PersonPicker'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { UserAvatar } from '../../../shared/UserAvatar'
import {
  useAddPageShare,
  usePageShares,
  useRemovePageShare,
  useSetPageShareAccess,
} from './share-hooks'
import { shareIntroSentence, SHARED_SEARCH_SENTENCE, shareLevelLabel, type ShareSubjectKind } from './sharing-copy'

/**
 * Share — the one surface in the Finder that actually grants access
 * (menus-and-dialogs.md §4.1).
 *
 * **There is no approval step, by design and by the owner's instruction.**
 * Picking a person writes the grant and the recipient has it on their next
 * read. The agent publication gate (`knowledge.page.publish`) is a different
 * mechanism for a different actor and is never involved here; the sentence
 * under the title says so on screen, every time, so the person granting is
 * never surprised by what they just did.
 *
 * There is no Save button either: the dialog *is* the state. Every control
 * writes on use and the list below is the record of what happened, which is
 * why an error lands under the picker rather than beside a submit nobody
 * pressed.
 */

type ShareDialogProps = {
  onClose: () => void
  /** Copies the `?pageId=` link, which works for a grantee. */
  onCopyLink?: () => void
  open: boolean
  pageId: string
  spaceId?: string
  subjectKind: ShareSubjectKind
  title: string
}

const LEVEL_OPTIONS: { value: KnowledgePageShareAccess; label: string; description: string }[] = [
  { description: 'Read and download', label: 'Can view', value: 'view' },
  { description: 'Also change what is in it', label: 'Can edit', value: 'edit' },
]

/** One grantee: who they are, and the level button that changes or revokes it. */
const ShareRow = ({
  name,
  onRemove,
  onSetAccess,
  share,
  token,
}: {
  name: string
  onRemove: () => void
  onSetAccess: (access: KnowledgePageShareAccess) => void
  share: KnowledgePageShareRecord
  token: string | null
}) => {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  return (
    <li className="flex items-center gap-2 py-1" data-testid="share-row">
      <UserAvatar displayName={name} size={20} token={token} userId={share.granteeUserId} />
      <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]">{name}</span>
      <button
        aria-haspopup="menu"
        className="flex items-center gap-1 rounded px-2 py-1 text-[color:var(--tx2)] hover:bg-[color:var(--overlay-weak)]"
        onClick={() => setOpen((value) => !value)}
        ref={buttonRef}
        type="button"
      >
        {/* The size goes on the span: an unlayered `button { font: inherit }`
            outranks a layered `text-xs` on the control itself. */}
        <span className="text-xs">{shareLevelLabel[share.access]}</span>
        <FontAwesomeIcon className="h-2.5 w-2.5" icon={faChevronDown} />
      </button>
      <Popover
        anchorRef={buttonRef}
        className="min-w-[180px] rounded-[var(--radius-md)] border border-[color:var(--sep)] bg-[color:var(--panel)] py-1 shadow-[0_16px_40px_var(--scrim-strong)]"
        label={`Access for ${name}`}
        onClose={() => setOpen(false)}
        open={open}
        placement="bottom-end"
        role="menu"
      >
        {LEVEL_OPTIONS.map((option) => (
          <button
            aria-checked={share.access === option.value}
            className="flex w-full items-center px-3 py-2 text-left text-[color:var(--tx)] hover:bg-[color:var(--accent)] hover:text-[color:var(--on-accent)]"
            key={option.value}
            onClick={() => {
              setOpen(false)
              onSetAccess(option.value)
            }}
            role="menuitemradio"
            type="button"
          >
            <span className="text-sm">{option.label}</span>
          </button>
        ))}
        <div className="my-1 h-px bg-[color:var(--sep)]" role="separator" />
        <button
          className="flex w-full items-center px-3 py-2 text-left text-[color:var(--danger-text)] hover:bg-[color:var(--danger)] hover:text-[color:var(--on-accent)]"
          onClick={() => {
            setOpen(false)
            onRemove()
          }}
          role="menuitem"
          type="button"
        >
          <span className="text-sm">Remove</span>
        </button>
      </Popover>
    </li>
  )
}

export const ShareDialog = ({
  onClose,
  onCopyLink,
  open,
  pageId,
  spaceId,
  subjectKind,
  title,
}: ShareDialogProps) => {
  const { me, token } = useAuthSession()
  const isUoaSession = me?.auth.providerType === 'uoa'
  const usersQuery = useUsers(open && !isUoaSession)
  const teamMembersQuery = useTeamMembers(open && isUoaSession)
  const sharesQuery = usePageShares(pageId, open)
  const addShare = useAddPageShare()
  const setAccess = useSetPageShareAccess()
  const removeShare = useRemovePageShare()

  // A form field, so `useState` rather than a URL param: the answer is used by
  // the next pick and thrown away, and a param would outlive the dialog.
  const [level, setLevel] = useState<KnowledgePageShareAccess>('view')
  const [formError, setFormError] = useState<string | undefined>()

  const people: PersonOption[] = isUoaSession
    ? (teamMembersQuery.data?.members ?? []).flatMap((member) => (member.userId
      ? [{ id: member.userId, name: member.displayName ?? member.email ?? 'Team member' }]
      : []))
    : (usersQuery.data ?? []).map((user) => ({ id: user.id, name: user.displayName }))

  const shares = sharesQuery.data ?? []
  const nameFor = (userId: string): string =>
    people.find((person) => person.id === userId)?.name ?? 'Someone'

  const granted = new Set(shares.map((share) => share.granteeUserId))
  const options = people.filter((person) => person.id !== me?.user.id && !granted.has(person.id))

  const add = (person: PersonOption) => {
    setFormError(undefined)
    addShare.mutate(
      { access: level, granteeUserId: person.id, pageId, spaceId },
      { onError: (error) => setFormError(toFormErrors(error).formError ?? 'Couldn’t share this.') },
    )
  }

  return (
    <Dialog onClose={onClose} open={open} title={`Share “${title}”`}>
      <div className="grid gap-4">
        <p className="text-sm text-[color:var(--tx2)]" data-testid="share-intro">
          {shareIntroSentence(subjectKind)}
        </p>

        <div className="grid gap-2">
          <PersonPicker
            label="People to share with"
            onSelect={add}
            options={options}
            placeholder="Add a person…"
          />
          <ChoiceGroup
            label="Access"
            onChange={setLevel}
            options={LEVEL_OPTIONS}
            value={level}
          />
          <FormError>{formError}</FormError>
        </div>

        <div className="grid gap-1.5">
          <SectionLabel size="sm">Has access</SectionLabel>
          <ul>
            <li className="flex items-center gap-2 py-1">
              <UserAvatar
                displayName={me?.user.displayName ?? 'You'}
                size={20}
                token={token}
                userId={me?.user.id}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]">
                {`${me?.user.displayName ?? 'You'} — Owner`}
              </span>
            </li>
            {shares.map((share) => (
              <ShareRow
                key={share.granteeUserId}
                name={nameFor(share.granteeUserId)}
                onRemove={() => removeShare.mutate({
                  granteeUserId: share.granteeUserId,
                  pageId,
                  spaceId,
                })}
                onSetAccess={(access) => setAccess.mutate({
                  access,
                  granteeUserId: share.granteeUserId,
                  pageId,
                  spaceId,
                })}
                share={share}
                token={token}
              />
            ))}
          </ul>
          {shares.length === 0 ? (
            <p className="text-sm text-[color:var(--tx3)]">Only you, so far.</p>
          ) : null}
        </div>

        {/* The honest limit, said at both levels: a shared page opens from
            Shared with me and is not in the recipient's search. */}
        <p className="text-xs text-[color:var(--tx3)]" data-testid="share-search-note">
          {SHARED_SEARCH_SENTENCE}
        </p>
      </div>

      <div className="flex justify-end gap-2 pt-5">
        {onCopyLink ? (
          <button className="admin-button admin-button-secondary" onClick={onCopyLink} type="button">
            Copy link
          </button>
        ) : null}
        <button className="admin-button admin-button-primary" onClick={onClose} type="button">
          Done
        </button>
      </div>
    </Dialog>
  )
}
