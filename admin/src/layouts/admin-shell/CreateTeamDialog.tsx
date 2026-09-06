import { useRef, useState, type FormEvent } from 'react'

import { toFormErrors } from '../../facades/forms/form-errors'
import {
  newIdempotencyKey,
  useCreateOrganization,
  useCreateTeamTeam,
} from '../../facades/team/provisioning'
import { Dialog } from '../../components/shared/Dialog'
import { FormActions, FormError } from '../../components/shared/FormActions'
import { FormField } from '../../components/shared/FormField'
import { Input } from '../../components/shared/FormControls'
import { TabBar } from '../../components/primitives/TabBar'
import { TeamAddressField } from './TeamAddressField'

/**
 * Creating an organisation, or a team inside the current one, in place.
 *
 * This replaces the rail's old "Add team" redirect, which sent the person
 * through UnlikeOtherAI's chooser and charged them a second interactive login
 * for what is two fields and a switch.
 *
 * One doorway, one dialog, one strip. The two flows differ upstream — founding
 * an organisation and adding a team to one are different acts with
 * different authorization — but to the person they are the same question
 * ("where do I want to work?") asked at two scopes, so a second entry point
 * would be the look-alike surface Rule zero names.
 */

type CreateScope = 'organization' | 'team'

type CreateTeamDialogProps = {
  /** The active organisation's name, so the team tab can say where. */
  organizationName?: string | null
  /** Hidden when the person is not in a UOA-linked team. */
  canCreateTeam: boolean
  onClose: () => void
  open: boolean
}

export const CreateTeamDialog = ({
  canCreateTeam,
  onClose,
  open,
  organizationName,
}: CreateTeamDialogProps) => {
  const [scope, setScope] = useState<CreateScope>('organization')
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  // An address UOA would refuse must not be submittable; an empty one is fine,
  // because UOA derives one from the name.
  const [addressUsable, setAddressUsable] = useState(true)
  const [formError, setFormError] = useState<string | undefined>()
  // Held across retries so a second attempt is recognised as the same intent.
  const idempotencyKey = useRef(newIdempotencyKey())
  const nameRef = useRef<HTMLInputElement>(null)

  const createOrganization = useCreateOrganization()
  const createTeam = useCreateTeamTeam()
  const active = scope === 'organization' ? createOrganization : createTeam
  const pending = active.isPending

  const handleClose = () => {
    if (pending) return
    setName('')
    setSlug('')
    setFormError(undefined)
    setScope('organization')
    idempotencyKey.current = newIdempotencyKey()
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || pending || !addressUsable) return
    setFormError(undefined)
    try {
      await active.mutateAsync({
        idempotencyKey: idempotencyKey.current,
        name: trimmed,
        slug: slug.trim() || undefined,
      })
      // The mutation has already switched and navigated; only the shell is left.
      setName('')
      setSlug('')
      idempotencyKey.current = newIdempotencyKey()
      onClose()
    } catch (error) {
      setFormError(
        toFormErrors(error).formError
          ?? 'Could not create it. Nothing was changed — try again.',
      )
    }
  }

  const inOrganization = organizationName?.trim()

  return (
    <Dialog
      dismissDisabled={pending}
      initialFocusRef={nameRef}
      onClose={handleClose}
      open={open}
      title={scope === 'organization' ? 'Create an organisation' : 'Create a team'}
    >
      <form className="grid gap-4" onSubmit={handleSubmit}>
        {/* Omitted entirely when only one flow is open to this person: a strip
            with one option is a label pretending to be a choice. */}
        {canCreateTeam ? (
          <TabBar
            ariaLabel="What to create"
            fullWidth
            items={[
              { label: 'New organisation', value: 'organization' },
              {
                label: inOrganization ? `In ${inOrganization}` : 'In this organisation',
                value: 'team',
              },
            ]}
            onChange={(next) => {
              if (pending) return
              setScope(next)
              setFormError(undefined)
            }}
            role="radiogroup"
            value={scope}
          />
        ) : null}

        <FormField label="Name" required>
          <Input
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
            placeholder={scope === 'organization' ? 'e.g. Acme Ltd' : 'e.g. Design'}
            ref={nameRef}
            value={name}
          />
        </FormField>

        <TeamAddressField
          disabled={pending}
          name={name}
          onChange={setSlug}
          onUsableChange={setAddressUsable}
          scope={scope === 'organization' ? 'organisation' : 'team'}
          value={slug}
        />

        <p className="text-xs text-[color:var(--tx3)]">
          {scope === 'organization'
            ? 'Creates the organisation in UnlikeOtherAI with you as its owner, and opens its first team.'
            : 'Adds a team to your current organisation and opens it.'}
        </p>

        <FormError>{formError}</FormError>

        <FormActions>
          <button
            className="admin-button admin-button-secondary"
            disabled={pending}
            onClick={handleClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!name.trim() || pending}
            type="submit"
          >
            {pending
              ? 'Creating…'
              : scope === 'organization' ? 'Create organisation' : 'Create team'}
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
