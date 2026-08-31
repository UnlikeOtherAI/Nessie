import { useEffect, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import {
  useCurrentOrganization,
  useUpdateOrganization,
} from '../../facades/organization/hooks'
import { useIsOwner } from '../../components/shared/OwnerGate'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { LogoPanel } from './organization/LogoPanel'
import { WorkspaceAvatarPanel } from './organization/WorkspaceAvatarPanel'
import { CallProviderSettingsPanel } from './organization/CallProviderSettingsPanel'
import {
  FeedbackBanner,
  SettingsPanel,
  type SettingsFeedback,
} from './settings-shared'
import { SectionLabel } from '../../components/primitives/SectionLabel'

export const OrganizationSettingsPage = () => {
  const { me } = useAuthSession()
  // Team call settings follow their API route: owners and admins can change
  // them. The organisation's own route authorizes the same two roles, so the
  // page remains one coherent home for its existing logo and profile controls.
  const isOwner = useIsOwner()
  const canManageOrganization = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const { data: organization, isLoading } = useCurrentOrganization()
  const updateOrganization = useUpdateOrganization()

  const [name, setName] = useState('')
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null)

  // Seed the input from the loaded org once per org id. Keying on id (not the
  // whole object) avoids a background refetch — e.g. after a logo save, which
  // shares this query — clobbering an unsaved name edit.
  const organizationId = organization?.id
  useEffect(() => {
    if (organization) {
      setName(organization.name)
    }
  }, [organizationId])

  if (!me) {
    return null
  }

  if (!canManageOrganization) {
    return <Navigate to="/settings/profile" replace />
  }

  const saveName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFeedback(null)
    try {
      await updateOrganization.mutateAsync({ name: name.trim() })
      setFeedback({ kind: 'success', message: 'Organisation name saved.' })
    } catch (error) {
      setFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Failed to save organisation name.',
      })
    }
  }

  const dirty = organization ? name.trim() !== organization.name : false
  const canSave = dirty && name.trim().length > 0 && !updateOrganization.isPending

  return (
    <SettingsPanel eyebrow="Organization" title="General">
      <div className="grid max-w-3xl gap-4">
        <section className="admin-card p-4">
          <SectionLabel>Profile</SectionLabel>
          <form className="mt-4 grid gap-3" onSubmit={saveName}>
            <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
              Organisation name
              <input
                className="admin-input"
                disabled={isLoading || updateOrganization.isPending}
                onChange={(event) => setName(event.target.value)}
                placeholder="Organisation name"
                value={name}
              />
            </label>
            <button
              className="admin-button admin-button-primary justify-self-start disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!canSave}
              type="submit"
            >
              {updateOrganization.isPending ? 'Saving…' : 'Save name'}
            </button>
            <FeedbackBanner feedback={feedback} />
          </form>
        </section>

        <LogoPanel />
        <WorkspaceAvatarPanel />
        <CallProviderSettingsPanel />
      </div>
    </SettingsPanel>
  )
}
