import { useEffect, useState, type FormEvent } from 'react'
import { useCurrentOrganization, useUpdateOrganization } from '../../../facades/organization/hooks'
import { Card } from '../../../components/shared/Card'
import { FormActions, FormSuccess } from '../../../components/shared/FormActions'
import { FormField } from '../../../components/shared/FormField'
import { Input } from '../../../components/shared/FormControls'
import { LogoPanel } from './LogoPanel'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { SettingsPanel, type SettingsTabHostProps } from '../settings-shared'
import { WorkspaceAvatarPanel } from './WorkspaceAvatarPanel'
import { toFormErrors } from '../../../facades/form-errors'

/** Who the organisation is: its name, its logo, its workspace avatar. */
export const OrganizationProfilePage = ({ tabs }: SettingsTabHostProps) => {
  const { data: organization, isLoading } = useCurrentOrganization()
  const updateOrganization = useUpdateOrganization()

  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  // Seed the input from the loaded org once per org id. Keying on id (not the
  // whole object) avoids a background refetch — e.g. after a logo save, which
  // shares this query — clobbering an unsaved name edit.
  const organizationId = organization?.id
  useEffect(() => {
    if (organization) {
      setName(organization.name)
    }
  }, [organizationId])

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

  return (
    <SettingsPanel eyebrow="Organization" title="Profile">
      {tabs}
      <div className="grid gap-4">
        <Card as="section">
          <SectionLabel>Name</SectionLabel>
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
      </div>
    </SettingsPanel>
  )
}
