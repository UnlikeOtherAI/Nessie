import { useEffect, useState, type FormEvent } from 'react'

import { Card } from '../../../components/shared/Card'
import { FormActions, FormError, FormSuccess } from '../../../components/shared/FormActions'
import { FormField } from '../../../components/shared/FormField'
import { Input } from '../../../components/shared/FormControls'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { SettingsPanel, type SettingsTabHostProps } from '../../../components/shared/SettingsPanel'
import { TeamAvatarPanel } from './TeamAvatarPanel'
import { useRenameTeam } from '../../../facades/projects/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import type { TeamRecord } from '../../../lib/api-client'

const renameHelp = (externallyManaged: boolean, renamable: boolean): string | undefined => {
  if (!externallyManaged) return undefined
  return renamable
    ? 'This name belongs to your UnlikeOtherAI team. Saving renames it there, so it '
      + 'changes in every other UnlikeOtherAI product too.'
    : 'This name belongs to your UnlikeOtherAI team, and UnlikeOtherAI only accepts the '
      + 'change from inside it. Switch to this team to rename it.'
}

/**
 * A team's own identity: its name and the company picture UnlikeOtherAI
 * holds for it.
 *
 * Both are UOA's to store — a team *is* a UOA team — and both are changed
 * from here anyway, because the write is relayed to UOA rather than made
 * locally. This screen used to disable the field and say "rename it there and
 * it will follow here", which left the only way to rename your own team
 * outside the product you were standing in.
 */

export const TeamProfilePage = ({ tabs, team }: SettingsTabHostProps & { team?: TeamRecord }) => {
  const rename = useRenameTeam()
  const { me, reconcileSession } = useAuthSession()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Seed the input from the loaded team once per team id. Keying on the whole
  // record would let a background refetch clobber an unsaved rename, so `team`
  // is read at this render rather than depended on.
  const teamId = team?.id
  useEffect(() => {
    if (team) setName(team.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId])

  const externallyManaged = team?.externallyManaged ?? false
  // UnlikeOtherAI authorizes the rename as the signed-in person *in the
  // team they are in*: the assertion Nessie signs names one team and
  // UOA refuses it against any other. So this screen's team picker can
  // show another team but cannot rename it, and saying so beats a 403.
  const active = !team || team.id === me?.context.teamId
  const renamable = active || !externallyManaged
  const dirty = team ? name.trim() !== team.name : false

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!team) return
    setError(null)
    setSaved(false)
    try {
      // UnlikeOtherAI normalizes what it accepted and the route answers with the
      // name it stored, so adopt that rather than leaving the typed text in the
      // field: otherwise a normalized rename reads as unsaved — the input still
      // differs from the stored name, so Save re-enables itself the moment the
      // team list refetches.
      const stored = await rename.mutateAsync({ name: name.trim(), teamId: team.id })
      setName(stored.name)
      // The team switcher labels rows from the session payload, not from
      // the team list, so re-read it — otherwise the rail keeps the old name
      // until the next login and the rename looks like it only half worked.
      await reconcileSession()
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not rename this team.')
    }
  }

  return (
    <SettingsPanel eyebrow="Team" title="Profile">
      {tabs}
      <div className="grid gap-4">
        <Card as="section">
          <SectionLabel>Name</SectionLabel>
          <form className="mt-4 grid gap-3" onSubmit={save}>
            <FormField
              help={renameHelp(externallyManaged, renamable)}
              label="Team name"
            >
              <Input
                disabled={!team || !renamable || rename.isPending}
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
          UnlikeOtherAI hosts the team picture; Nessie stores none of its
          own. A team with no UOA binding — a local install, or a purely
          local team — therefore has nothing to preview and nowhere to upload
          to, so the panel is withheld rather than offering buttons that can
          only 404.
        */}
        {externallyManaged ? <TeamAvatarPanel team={team} /> : null}
      </div>
    </SettingsPanel>
  )
}
