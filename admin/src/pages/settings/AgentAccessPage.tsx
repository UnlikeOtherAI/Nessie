import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Card } from '../../components/shared/Card'
import { EmptyState } from '../../components/shared/EmptyState'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { Checkbox } from '../../components/primitives/Checkbox'
import { CodeInput } from '../../components/primitives/CodeInput'
import { Pill } from '../../components/primitives/Pill'
import { defaultGrantedScopes } from '../../facades/agent-access/scope-defaults'
import {
  useAgentAccessCredentials,
  useDecideAgentAuthorization,
  usePendingAgentAuthorization,
  useRevokeAgentAccessCredential,
  type AgentAccessScope,
} from '../../facades/agent-access/hooks'

/**
 * Agent access — approving a pairing, and seeing what you have lent.
 *
 * An agent credential acts as the person who approved it, so this page is the
 * moment a person decides to lend their own reach. That is why the approval
 * names the agent, lists exactly what it asked for, and lets the person grant
 * less; and why the list below it is not an afterthought — a foothold in your
 * account should be something you can see and take back, rather than something
 * that only exists in a config file on a machine somewhere.
 */

const SCOPE_COPY: Record<AgentAccessScope, { detail: string; label: string }> = {
  boards_read: {
    detail: 'Read your boards and the tasks on them, including boards mirrored from Linear.',
    label: 'Read boards',
  },
  boards_write: {
    detail: 'Create tasks, edit them, and move them between columns.',
    label: 'Change boards',
  },
  documents_read: {
    detail: 'Read the knowledge spaces and documents you can read.',
    label: 'Read documents',
  },
  documents_write: {
    detail: 'Create and edit documents as drafts.',
    label: 'Write documents',
  },
  documents_publish: {
    detail:
      'Make drafts visible to everyone who can read the space. Publishing is '
      + 'normally a person\'s decision — most agents do not need this.',
    label: 'Publish documents',
  },
}



const formatWhen = (value: string | null): string => {
  if (!value) return 'never'
  return new Date(value).toLocaleString()
}

export const AgentAccessPage = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  // The agent prints a `verification_uri_complete` carrying the code, so
  // arriving from it should land on the decision, not on a form to retype it.
  // Held compact (no dash): the input renders the grouping, and the server
  // normalises either shape.
  const [code, setCode] = useState(
    (searchParams.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
  )
  const [granted, setGranted] = useState<AgentAccessScope[]>([])
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null)
  // A failed decision or revoke has to be visible: silently leaving a
  // credential live is the one outcome a person must never be left guessing at.
  const [actionError, setActionError] = useState<string | null>(null)

  const pending = usePendingAgentAuthorization(code)
  const credentials = useAgentAccessCredentials()
  const decide = useDecideAgentAuthorization()
  const revoke = useRevokeAgentAccessCredential()

  const requested = useMemo(
    () => pending.data?.requestedScopes ?? [],
    [pending.data?.requestedScopes],
  )

  // Default to everything the agent asked for — except the scopes whose
  // granting is itself the deliberate act.
  useEffect(() => {
    setGranted(defaultGrantedScopes(requested))
  }, [requested])

  const rows = credentials.data?.credentials ?? []

  const submit = (approve: boolean) => {
    setActionError(null)
    decide.mutate(
      { approve, scopes: approve ? granted : [], userCode: code },
      {
        onError: (error) =>
          setActionError(
            error instanceof Error
              ? error.message
              : 'That decision could not be recorded. Try again.',
          ),
        onSuccess: () => {
          setDecided(approve ? 'approved' : 'denied')
          // The code is single use; leaving it in the URL invites a reload that
          // can only fail.
          searchParams.delete('code')
          setSearchParams(searchParams, { replace: true })
        },
      },
    )
  }

  return (
    <SettingsPanel eyebrow="Settings" title="Agent access">
      <div className="grid max-w-3xl gap-5">
        <Card>
          <SectionLabel>Pair an agent</SectionLabel>
          <p className="mt-1 text-sm text-[color:var(--tx2)]">
            An agent that asks for access prints a short code. Enter it here to see
            what it is asking for. Whatever you approve, it acts as you — it can
            never reach anything you could not.
          </p>

          <div className="mt-3">
            <CodeInput
              label="Pairing code"
              onChange={(next) => {
                setDecided(null)
                setActionError(null)
                setCode(next)
              }}
              value={code}
            />
          </div>

          {actionError ? (
            <p className="mt-3 text-sm text-[color:var(--danger-text)]">{actionError}</p>
          ) : null}

          {decided ? (
            <p className="mt-3 text-sm text-[color:var(--tx2)]">
              {decided === 'approved'
                ? 'Approved. The agent will pick up its credential within a few seconds.'
                : 'Refused. The agent was told to stop asking.'}
            </p>
          ) : null}

          {code.trim().length > 0 && !decided && pending.isError ? (
            <p className="mt-3 text-sm text-[color:var(--danger-text)]">
              That code is not valid. It may have expired, or already been used —
              ask the agent for a new one.
            </p>
          ) : null}

          {pending.data && !decided ? (
            <div className="mt-4 rounded-lg border border-[var(--bd)] p-3">
              <div className="text-sm font-medium text-[var(--tx)]">
                {pending.data.clientName} is asking for access
              </div>
              <p className="mt-1 text-xs text-[color:var(--tx3)]">
                Untrusted — this name is whatever the agent calls itself.
              </p>

              <div className="mt-3 grid gap-2">
                {requested.map((scope) => (
                  <Checkbox
                    checked={granted.includes(scope)}
                    description={SCOPE_COPY[scope].detail}
                    key={scope}
                    label={SCOPE_COPY[scope].label}
                    onChange={(checked) =>
                      setGranted((current) =>
                        checked
                          ? [...current, scope]
                          : current.filter((held) => held !== scope))}
                  />
                ))}
              </div>

              <div className="mt-4 flex items-center gap-2">
                <button
                  className="admin-button admin-button-primary"
                  disabled={decide.isPending || granted.length === 0}
                  onClick={() => submit(true)}
                  type="button"
                >
                  {decide.isPending ? 'Approving…' : 'Approve'}
                </button>
                <button
                  className="admin-button admin-button-secondary"
                  disabled={decide.isPending}
                  onClick={() => submit(false)}
                  type="button"
                >
                  Refuse
                </button>
              </div>
            </div>
          ) : null}
        </Card>

        <Card>
          <SectionLabel>Agents with access</SectionLabel>
          {rows.length === 0 ? (
            <div className="mt-2">
              <EmptyState title="No agents paired">
                Nothing is holding a credential for your account.
              </EmptyState>
            </div>
          ) : (
            <div className="mt-2 grid gap-2">
              {rows.map((credential) => {
                const expired = new Date(credential.expiresAt).getTime() <= Date.now()
                const dead = credential.revokedAt !== null || expired
                return (
                  <div
                    className="flex items-start justify-between gap-3 rounded-lg border border-[var(--bd)] p-3"
                    key={credential.id}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-[var(--tx)]">
                          {credential.label}
                        </span>
                        <Pill tone={dead ? 'muted' : 'success'}>
                          {credential.revokedAt ? 'revoked' : expired ? 'expired' : 'active'}
                        </Pill>
                      </div>
                      <div className="mt-0.5 text-xs text-[color:var(--tx3)]">
                        {credential.tokenPrefix}… · last used {formatWhen(credential.lastUsedAt)}
                        {' · '}
                        {credential.scopes.map((scope) => SCOPE_COPY[scope].label).join(', ')
                          || 'no scopes'}
                      </div>
                    </div>
                    {dead ? null : (
                      <button
                        className="admin-button admin-button-secondary flex-shrink-0"
                        disabled={revoke.isPending}
                        onClick={() => {
                          setActionError(null)
                          revoke.mutate(credential.id, {
                            onError: (error) =>
                              setActionError(
                                error instanceof Error
                                  ? error.message
                                  : 'That credential could not be revoked. It is still live.',
                              ),
                          })
                        }}
                        type="button"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>
    </SettingsPanel>
  )
}
