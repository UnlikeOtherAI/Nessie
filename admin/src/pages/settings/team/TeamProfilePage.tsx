import { useEffect, useState, type FormEvent } from 'react'

import { Card } from '../../../components/shared/Card'
import { FormActions, FormError, FormSuccess } from '../../../components/shared/FormActions'
import { FormField } from '../../../components/shared/FormField'
import { Input } from '../../../components/shared/FormControls'
import { Notice } from '../../../components/primitives/Notice'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { SettingsPanel, type SettingsTabHostProps } from '../settings-shared'
import { WorkspaceAvatarPanel } from '../organization/WorkspaceAvatarPanel'
import { useRenameTeam } from '../../../facades/projects/hooks'
import type { TeamRecord } from '../../../lib/api-client'

/**
 * A team's own identity. The picture is the workspace avatar UnlikeOtherAI
 * holds — the same one every UOA surface shows for this workspace — and the
 * name is UOA's too wherever this team is bound to a UOA workspace: `Team.name`
 * is a mirror, so editing it here would create the second copy of the org
 * structure the SSO invariant forbids and be overwritten by the next roster
 * read. A local install with no identity provider owns its own names.
 */
export const TeamProfilePage = ({ tabs, team }: SettingsTabHostProps & { team?: TeamRecord }) => {
  const rename = useRenameTeam()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const teamId = team?.id
  useEffect(() => {
    if (team) setName(team.name)
  }, [teamId])

  const externallyManaged = team?.externallyManaged ?? false
  const dirty = team ? name.trim() !== team.name : false

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!team) return
    setError(null)
    setSaved(false)
    try {
      await rename.mutateAsync({ name: name.trim(), teamId: team.id })
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not rename this team.')
    }
  }

  return (
    <SettingsPanel eyebrow="Team" title="Profile">
      {tabs}
      <div className="grid max-w-3xl gap-4">
        <Card as="section">
          <SectionLabel>Name</SectionLabel>
          {externallyManaged ? (
            <Notice className="mt-3" tone="info">
              This workspace’s name is held by UnlikeOtherAI. Rename it there and it will
              follow here.
            </Notice>
          ) : null}
          <form className="mt-4 grid gap-3" onSubmit={save}>
            <FormField label="Team name">
              <Input
                disabled={externallyManaged || !team || rename.isPending}
                onChange={(event) => {
                  setName(event.target.value)
                  setSaved(false)
                }}
                placeholder="Team name"
                value={name}
              />
            </FormField>
            <FormError>{error ?? undefined}</FormError>
            <FormSuccess>{saved ? 'Team name saved.' : undefined}</FormSuccess>
            {externallyManaged ? null : (
              <FormActions>
                <button
                  className="admin-button admin-button-primary disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!dirty || name.trim().length === 0 || rename.isPending}
                  type="submit"
                >
                  {rename.isPending ? 'Saving…' : 'Save name'}
                </button>
              </FormActions>
            )}
          </form>
        </Card>

        <WorkspaceAvatarPanel />
      </div>
    </SettingsPanel>
  )
}
