import { useEffect, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import {
  useCurrentOrganization,
  useUpdateConversationalSetup,
  useUpdateOrganization,
} from '../../facades/organization/hooks'
import { useIsOwner } from '../../components/shared/OwnerGate'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { CloudBrowserPanel } from '../../components/features/browser-cloud/CloudBrowserPanel'
import { LogoPanel } from './organization/LogoPanel'
import { WorkspaceAvatarPanel } from './organization/WorkspaceAvatarPanel'
import { CallProviderSettingsPanel } from './organization/CallProviderSettingsPanel'
import { ConversationalSetupPanel } from './organization/ConversationalSetupPanel'
import { SettingsPanel } from './settings-shared'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { Card } from '../../components/shared/Card'
import { FormField } from '../../components/shared/FormField'
import { Input } from '../../components/shared/FormControls'
import { FormActions, FormSuccess } from '../../components/shared/FormActions'
import { toFormErrors } from '../../facades/form-errors'

export const OrganizationSettingsPage = () => {
  const { me } = useAuthSession()
  // Team call settings follow their API route: owners and admins can change
  // them. The organisation's own route authorizes the same two roles, so the
  // page remains one coherent home for its existing logo and profile controls.
  const isOwner = useIsOwner()
  const canManageOrganization = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const { data: organization, isLoading } = useCurrentOrganization()
  const updateOrganization = useUpdateOrganization()
  const updateConversationalSetup = useUpdateConversationalSetup()

  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [conversationalSetupError, setConversationalSetupError] = useState<string | null>(null)

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
    setNameError(undefined)
    setSaved(false)
    try {
      await updateOrganization.mutateAsync({ name: name.trim() })
      setSaved(true)
    } catch (error) {
      const { fieldErrors, formError } = toFormErrors(error)
      setNameError(fieldErrors.name ?? formError ?? 'Failed to save organisation name.')
    }
  }

  const dirty = organization ? name.trim() !== organization.name : false
  const canSave = dirty && name.trim().length > 0 && !updateOrganization.isPending

  const updateConversationalSetupEnabled = async (conversationalSetupEnabled: boolean) => {
    setConversationalSetupError(null)
    try {
      await updateConversationalSetup.mutateAsync(conversationalSetupEnabled)
    } catch (error) {
      setConversationalSetupError(
        error instanceof Error
          ? error.message
          : 'Failed to update conversational agent setup early access.',
      )
    }
  }

  return (
    <SettingsPanel eyebrow="Organization" title="General">
      <div className="grid max-w-3xl gap-4">
        <Card as="section">
          <SectionLabel>Profile</SectionLabel>
          <form className="mt-4 grid gap-3" onSubmit={saveName}>
            <FormField
              error={nameError}
              help={
                organization?.nameManagedExternally
                  ? 'This name belongs to your UnlikeOtherAI organisation. Saving renames it '
                    + 'there, so it changes on the sign-in screen and in every other '
                    + 'UnlikeOtherAI product too.'
                  : undefined
              }
              label="Organisation name"
            >
              <Input
                disabled={isLoading || updateOrganization.isPending}
                onChange={(event) => {
                  setName(event.target.value)
                  setSaved(false)
                }}
                placeholder="Organisation name"
                value={name}
              />
            </FormField>
            <FormSuccess>{saved ? 'Organisation name saved.' : undefined}</FormSuccess>
            <FormActions>
              <button
                className="admin-button admin-button-primary disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!canSave}
                type="submit"
              >
                {updateOrganization.isPending ? 'Saving…' : 'Save name'}
              </button>
            </FormActions>
          </form>
        </Card>

        <LogoPanel />
        <WorkspaceAvatarPanel />
        <CallProviderSettingsPanel />
        {organization?.role === 'owner' ? <CloudBrowserPanel scope="organization" /> : null}
        {organization?.role === 'owner' ? (
          <ConversationalSetupPanel
            enabled={organization.conversationalSetupEnabled}
            error={conversationalSetupError}
            onChange={(enabled) => void updateConversationalSetupEnabled(enabled)}
            pending={updateConversationalSetup.isPending}
          />
        ) : null}
      </div>
    </SettingsPanel>
  )
}
