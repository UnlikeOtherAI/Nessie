import { useEffect, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import {
  useCurrentOrganization,
  useUpdateOrganization,
} from '../../facades/organization/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { LogoPanel } from './organization/LogoPanel'
import { sectionTitleClass, SettingsPanel } from './settings-shared'

const ADMIN_ROLES = new Set(['owner', 'admin'])

type Feedback = { kind: 'success' | 'error'; message: string }

export const OrganizationSettingsPage = () => {
  const { me } = useAuthSession()
  const { data: organization, isLoading } = useCurrentOrganization()
  const updateOrganization = useUpdateOrganization()

  const [name, setName] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  useEffect(() => {
    if (organization) {
      setName(organization.name)
    }
  }, [organization])

  if (!me) {
    return null
  }

  // Org administration is for owners/admins; everyone else goes back to profile.
  // (Owner is the common case; admins are honoured by the API too.)
  const isAdmin = organization ? ADMIN_ROLES.has(organization.role) : false
  if (organization && !isAdmin) {
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
          <div className={sectionTitleClass}>Profile</div>
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
            {feedback ? (
              <div
                className={[
                  'rounded-md border px-3 py-2 text-sm',
                  feedback.kind === 'success'
                    ? 'border-[color:var(--success-border)] bg-[color:var(--success-soft)] text-[color:var(--success-text)]'
                    : 'border-[color:var(--danger-border)] bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
                ].join(' ')}
              >
                {feedback.message}
              </div>
            ) : null}
          </form>
        </section>

        <LogoPanel />
      </div>
    </SettingsPanel>
  )
}
