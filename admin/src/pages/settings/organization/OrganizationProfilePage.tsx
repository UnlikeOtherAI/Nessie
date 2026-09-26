import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useCurrentOrganization, useUpdateOrganization } from '../../../facades/organization/hooks'
import { Card } from '../../../components/shared/Card'
import { FormActions, FormSuccess } from '../../../components/shared/FormActions'
import { FormField } from '../../../components/shared/FormField'
import { Input } from '../../../components/shared/FormControls'
import { LogoPanel } from './LogoPanel'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { SettingsPanel, type SettingsTabHostProps } from '../../../components/shared/SettingsPanel'
import { toFormErrors } from '../../../facades/forms/form-errors'

/**
 * Who the organisation is: its name and its logo.
 *
 * Not its team picture. That belongs to a team, not to the tenant —
 * one organisation holds many — and it is edited on the team's own Profile
 * screen. Offering it here as well was a second surface for one capability, and
 * put a control that rewrites one team's identity on a page about all of
 * them.
 */
export const OrganizationProfilePage = ({ tabs }: SettingsTabHostProps) => {
  const { t } = useTranslation('settings')
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
    // `organization` is read at this render, never a dependency — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setNameError(fieldErrors.name ?? formError ?? t('organization.nameSaveFailed'))
    }
  }

  const dirty = organization ? name.trim() !== organization.name : false
  const canSave = dirty && name.trim().length > 0 && !updateOrganization.isPending

  return (
    <SettingsPanel eyebrow={t('organization.organisation')} title={t('profile.title')}>
      {tabs}
      <div className="grid gap-4">
        <Card as="section">
          <SectionLabel>{t('organization.name')}</SectionLabel>
          <form className="mt-4 grid gap-3" onSubmit={saveName}>
            <FormField
              error={nameError}
              help={
                organization?.nameManagedExternally
                  ? t('organization.managedNameHelp')
                  : undefined
              }
              label={t('organization.organisationName')}
            >
              <Input
                disabled={isLoading || updateOrganization.isPending}
                onChange={(event) => {
                  setName(event.target.value)
                  setSaved(false)
                }}
                placeholder={t('organization.organisationName')}
                value={name}
              />
            </FormField>
            <FormSuccess>{saved ? t('organization.nameSaved') : undefined}</FormSuccess>
            <FormActions>
              <button
                className="admin-button admin-button-primary disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!canSave}
                type="submit"
              >
                {updateOrganization.isPending ? t('common.saving') : t('organization.saveName')}
              </button>
            </FormActions>
          </form>
        </Card>

        <LogoPanel />
      </div>
    </SettingsPanel>
  )
}
