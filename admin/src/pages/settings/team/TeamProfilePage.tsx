import { useEffect, useState, type FormEvent } from 'react'

import { Card } from '../../../components/shared/Card'
import { FormActions, FormError, FormSuccess } from '../../../components/shared/FormActions'
import { FormField } from '../../../components/shared/FormField'
import { Input } from '../../../components/shared/FormControls'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { SettingsPanel, type SettingsTabHostProps } from '../settings-shared'
import { WorkspaceAvatarPanel } from './WorkspaceAvatarPanel'
import { useRenameTeam } from '../../../facades/projects/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import type { TeamRecord } from '../../../lib/api-client'

const renameHelp = (externallyManaged: boolean, renamable: boolean): string | undefined => {
  if (!externallyManaged) return undefined
  return renamable
    ? 'This name belongs to your UnlikeOtherAI workspace. Saving renames it there, so it '
      + 'changes in every other UnlikeOtherAI product too.'
    : 'This name belongs to your UnlikeOtherAI workspace, and UnlikeOtherAI only accepts the '
      + 'change from inside it. Switch to this workspace to rename it.'
}

/**
 * A workspace's own identity: its name and the company picture UnlikeOtherAI
 * holds for it.
 *
 * Both are UOA's to store — a workspace *is* a UOA team — and both are changed
 * from here anyway, because the write is relayed to UOA rather than made
 * locally. This screen used to disable the field and say "rename it there and
 * it will follow here", which left the only way to rename your own workspace
 * outside the product you were standing in.
 */

export const TeamProfilePage = ({ tabs, team }: SettingsTabHostProps & { team?: TeamRecord }) => {
  const rename = useRenameTeam()
  const { me, reconcileSession } = useAuthSession()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const teamId = team?.id
  useEffect(() => {
    if (team) setName(team.name)
  }, [teamId])

  const externallyManaged = team?.externallyManaged ?? false
  // UnlikeOtherAI authorizes the rename as the signed-in person *in the
  // workspace they are in*: the assertion Nessie signs names one workspace and
  // UOA refuses it against any other. So this screen's workspace picker can
  // show another workspace but cannot rename it, and saying so beats a 403.
  const active = !team || team.id === me?.context.teamId
  const renamable = active || !externallyManaged
  const dirty = team ? name.trim() !== team.name : false

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!team) return
    setError(null)
    setSaved(false)
    try {
      await rename.mutateAsync({ name: name.trim(), teamId: team.id })
      // The workspace switcher labels rows from the session payload, not from
      // the team list, so re-read it — otherwise the rail keeps the old name
      // until the next login and the rename looks like it only half worked.
      await reconcileSession()
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not rename this workspace.')
    }
  }

  return (
    <SettingsPanel eyebrow="Team" title="Profile">
      {tabs}
      <div className="grid max-w-3xl gap-4">
        <Card as="section">
          <SectionLabel>Name</SectionLabel>
          <form className="mt-4 grid gap-3" onSubmit={save}>
            <FormField
              help={renameHelp(externallyManaged, renamable)}
              label="Workspace name"
            >
              <Input
                disabled={!team || !renamable || rename.isPending}
                onChange={(event) => {
                  setName(event.target.value)
                  setSaved(false)
                }}
                placeholder="Workspace name"
                value={name}
              />
            </FormField>
            <FormError>{error ?? undefined}</FormError>
            <FormSuccess>{saved ? 'Workspace name saved.' : undefined}</FormSuccess>
            {renamable ? (
              <FormActions>
                <button
                  className="admin-button admin-button-primary disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!dirty || name.trim().length === 0 || rename.isPending}
                  type="submit"
                >
                  {rename.isPending ? 'Saving…' : 'Save name'}
                </button>
              </FormActions>
            ) : null}
          </form>
        </Card>

        {/*
          UnlikeOtherAI hosts the workspace picture; Nessie stores none of its
          own. A workspace with no UOA binding — a local install, or a purely
          local team — therefore has nothing to preview and nowhere to upload
          to, so the panel is withheld rather than offering buttons that can
          only 404.
        */}
        {externallyManaged ? <WorkspaceAvatarPanel team={team} /> : null}
      </div>
    </SettingsPanel>
  )
}
