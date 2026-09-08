import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Card } from '../../components/shared/Card'
import { EmptyState } from '../../components/shared/EmptyState'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { Checkbox } from '../../components/primitives/Checkbox'
import { CodeInput } from '../../components/primitives/CodeInput'
import { Pill } from '../../components/primitives/Pill'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  useAgentAccessCredentials,
  useDecideAgentAuthorization,
  usePendingAgentAuthorization,
  useRevokeAgentAccessCredential,
  type AgentAccessScope,
} from '../../facades/agent-access/hooks'

/**
 * Paired agents — lending your account to a program, and taking it back.
 *
 * This page was called "Agent access" and could not be read. Four other
 * surfaces in this admin use "agent access" and "agents with access" to mean
 * *which of our own agents may reach this resource*; here it meant the inverse,
 * so a person arriving cold was primed for the wrong thing and found a code box
 * and an Approve button. The label was doing the damage, and the fix is to name
 * the interaction — you pair an agent, the way you pair a phone — and to name
 * the products doing the pairing, because "Claude Code, Codex" tells somebody
 * what this is faster than any abstract noun will.
 *
 * The structure is inverted from the original for the same reason. The form
 * used to come first, which reads as "do this thing" before "here is what this
 * is" — and most arrivals never type anything anyway, because the agent prints
 * a link that carries the code. So the page leads with what a paired agent is,
 * and the code entry is the fallback path it actually is.
 *
 * The decision block says the whole sentence: which agent, as whom, until when,
 * and what it will be able to do. An expiry a person cannot see is a grant
 * nobody remembers giving.
 */

const SCOPE_COPY: Record<AgentAccessScope, { detail: string; label: string }> = {
  boards_read: {
    detail: 'See your boards and the tasks on them, including boards mirrored from Linear.',
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
    detail:
      'Create and edit documents as drafts. Publishing one still comes to you as '
      + 'an approval — an agent can ask, but it cannot publish.',
    label: 'Write documents as drafts',
  },
}

const SCOPE_ORDER: AgentAccessScope[] = [
  'boards_read',
  'boards_write',
  'documents_read',
  'documents_write',
]

const formatDate = (value: string): string =>
  new Date(value).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

const formatLastUsed = (value: string | null): string => {
  if (!value) return 'never used'
  const elapsed = Date.now() - new Date(value).getTime()
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'used just now'
  if (minutes < 60) return `used ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `used ${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `used ${days} day${days === 1 ? '' : 's'} ago`
  return `last used ${formatDate(value)}`
}

/** What a row's scopes amount to, in a phrase rather than a list of labels. */
const describeScopes = (scopes: AgentAccessScope[]): string => {
  if (scopes.length === 0) return 'Nothing granted'
  const boards = scopes.includes('boards_write')
    ? 'read and change boards'
    : scopes.includes('boards_read')
      ? 'read boards'
      : null
  const documents = scopes.includes('documents_write')
    ? 'draft documents'
    : scopes.includes('documents_read')
      ? 'read documents'
      : null
  const parts = [boards, documents].filter((part): part is string => part !== null)
  const sentence = parts.join(', ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

export const PairedAgentsPage = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  // The agent prints a `verification_uri_complete` carrying the code, so
  // arriving from it should land on the decision, not on a form to retype it.
  // Held compact (no dash): the input renders the grouping, and the server
  // normalises either shape.
  const [code, setCode] = useState(
    (searchParams.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
  )
  const [granted, setGranted] = useState<AgentAccessScope[]>([])
  const [decided, setDecided] = useState<'allowed' | 'refused' | null>(null)
  // A failed decision or revoke has to be visible: silently leaving a
  // credential live is the one outcome a person must never be left guessing at.
  const [actionError, setActionError] = useState<string | null>(null)

  const pending = usePendingAgentAuthorization(code)
  const credentials = useAgentAccessCredentials()
  const decide = useDecideAgentAuthorization()
  const revoke = useRevokeAgentAccessCredential()
  const { me } = useAuthSession()

  const requested = useMemo(
    () => pending.data?.requestedScopes ?? [],
    [pending.data?.requestedScopes],
  )

  // Everything asked for starts ticked. Granting *less* is the deliberate act,
  // and there is no longer a scope that inverts that: publishing left this
  // screen entirely and became an approval per document.
  useEffect(() => {
    setGranted(requested)
  }, [requested])

  const rows = credentials.data?.credentials ?? []
  const live = rows.filter(
    (row) => row.revokedAt === null && new Date(row.expiresAt).getTime() > Date.now(),
  )

  // The server refuses a pairing with no active project and team, and it used
  // to do so only after the click. Saying it up front costs a person nothing;
  // finding out by pressing Allow costs them the guess about what went wrong.
  const tenantReady = Boolean(me?.context.projectId && me?.context.teamId)

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
          setDecided(approve ? 'allowed' : 'refused')
          // The code is single use; leaving it in the URL invites a reload that
          // can only fail.
          searchParams.delete('code')
          setSearchParams(searchParams, { replace: true })
        },
      },
    )
  }

  return (
    <SettingsPanel eyebrow="User" title="Paired agents">
      <div className="grid max-w-3xl gap-5">
        <Card>
          <SectionLabel>What this is</SectionLabel>
          <p className="mt-1 text-sm text-[color:var(--tx2)]">
            Claude Code, Codex and other MCP clients, working in Nessie as you.
          </p>
          <p className="mt-2 text-sm text-[color:var(--tx2)]">
            A paired agent reaches exactly what you reach — the boards and documents
            your account can see, and never more. It cannot publish a document on its
            own: that comes back to you as an approval. Everything you lend here you
            can take back here.
          </p>

          <div className="mt-4 rounded-lg border border-[var(--bd)] p-3">
            <div className="text-sm font-medium text-[var(--tx)]">Pair an agent</div>
            <p className="mt-1 text-sm text-[color:var(--tx2)]">
              Ask the agent to connect to Nessie. It prints a link and a short code —
              open the link, or type the code here.
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

            {!tenantReady ? (
              <p className="mt-3 text-sm text-[color:var(--tx3)]">
                Pick an active project and team first — a paired agent is scoped to
                one, and pairing cannot be completed without it.
              </p>
            ) : null}
          </div>

          {actionError ? (
            <p className="mt-3 text-sm text-[color:var(--danger-text)]">{actionError}</p>
          ) : null}

          {decided ? (
            <p className="mt-3 text-sm text-[color:var(--tx2)]">
              {decided === 'allowed'
                ? 'Paired. The agent picks up its credential within a few seconds.'
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
                <span className="font-semibold">{pending.data.clientName}</span>
                {' wants to work as you until '}
                {formatDate(pending.data.credentialExpiresAt)}.
              </div>

              <p className="mt-3 text-xs uppercase tracking-wide text-[color:var(--tx3)]">
                It will be able to
              </p>
              <div className="mt-2 grid gap-2">
                {SCOPE_ORDER.filter((scope) => requested.includes(scope)).map((scope) => (
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

              {/* The old copy said "Untrusted — this name is whatever the agent
                  calls itself", which is exactly right and reads as jargon. The
                  fact survives; the word does not. */}
              <p className="mt-3 text-xs text-[color:var(--tx3)]">
                Only allow this if you just ran a tool that printed this code. The name
                above is whatever that tool calls itself, and nothing checks it.
              </p>

              <div className="mt-4 flex items-center gap-2">
                <button
                  className="admin-button admin-button-primary"
                  disabled={decide.isPending || granted.length === 0 || !tenantReady}
                  onClick={() => submit(true)}
                  type="button"
                >
                  {decide.isPending ? 'Pairing…' : 'Allow'}
                </button>
                <button
                  className="admin-button admin-button-secondary"
                  disabled={decide.isPending}
                  onClick={() => submit(false)}
                  type="button"
                >
                  Don&rsquo;t allow
                </button>
              </div>
            </div>
          ) : null}
        </Card>

        <Card>
          <SectionLabel>
            {live.length > 0 ? `Paired agents (${live.length})` : 'Paired agents'}
          </SectionLabel>
          {rows.length === 0 ? (
            <div className="mt-2">
              <EmptyState title="Nothing paired yet">
                No program is holding a credential for your account.
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
                      <div className="mt-0.5 text-xs text-[color:var(--tx2)]">
                        Working as you · {describeScopes(credential.scopes)}
                      </div>
                      <div className="mt-0.5 text-xs text-[color:var(--tx3)]">
                        {`Paired ${formatDate(credential.createdAt)}`}
                        {credential.revokedAt
                          ? ` · revoked ${formatDate(credential.revokedAt)}`
                          : ` · ${expired ? 'expired' : 'expires'} ${formatDate(credential.expiresAt)}`}
                        {' · '}
                        {formatLastUsed(credential.lastUsedAt)}
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
