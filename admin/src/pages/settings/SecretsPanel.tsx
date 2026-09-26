import { useMemo, useState } from 'react'
import { DEFAULT_PAGE_LIMIT } from '@nessie/schemas'

import { CreateSecretDialog } from '../../components/features/settings/CreateSecretDialog'
import {
  resolveSecretRows,
  secretMatchesTab,
  SecretMetadataTable,
  type SecretPageScope,
  type SecretsTab,
} from '../../components/features/settings/SecretMetadataTable'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { PaginationFooter } from '../../components/shared/PaginationFooter'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { TabBar, type TabBarItem } from '../../components/primitives/TabBar'
import { useProjects } from '../../facades/projects/hooks'
import {
  useCreateSecret,
  useRevokeSecret,
  useSecrets,
} from '../../facades/secrets/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useTabParam } from '../../navigation/useTabParam'
import { FeedbackBanner, type SettingsFeedback } from './FeedbackBanner'
import { SettingsPanel, type SettingsTabHostProps } from '../../components/shared/SettingsPanel'

const SECRETS_TABS = ['active', 'revoked'] as const

const TAB_LABEL: Record<SecretsTab, string> = {
  active: 'Active',
  revoked: 'Revoked',
}

type SecretsPanelCopy = {
  cascade: string
  eyebrow: string
  intro: string
  title: string
}

/**
 * One page per level, each saying what its own level is rather than restating
 * the whole cascade three times. The eyebrow is where the page lives — Your
 * settings, or the Organisation group, whose Keys page shows the organisation
 * and each team behind its scope switch — so the levels read as one family.
 */
const COPY: Record<SecretPageScope, SecretsPanelCopy> = {
  organization: {
    cascade: 'A team or a person can save their own secret with the same key and theirs wins — '
      + 'unless this one is locked, in which case theirs is refused and this one applies everywhere.',
    eyebrow: 'Organisation',
    intro: 'The company\'s credentials. Every team and every person inherits these unless they '
      + 'save their own under the same key.',
    title: 'Keys',
  },
  personal: {
    cascade: 'Your own secret beats your project\'s, which beats your team\'s, which beats the '
      + 'organisation\'s. A key locked at a level above cannot be overridden, and is greyed out here.',
    eyebrow: 'Your settings',
    intro: 'Everything that reaches you: your own secrets, plus what your team and organisation set.',
    title: 'Saved keys',
  },
  team: {
    cascade: 'A team secret beats the organisation\'s, and a person\'s own beats both — unless a '
      + 'key is locked, which pins it for everybody below and greys it out there.',
    eyebrow: 'Organisation',
    intro: 'What this team\'s work runs on: the team\'s own secrets, plus what the organisation set.',
    title: 'Keys',
  },
}

type SecretsPanelProps = {
  /** The screen hosting this panel: Keys, whose scope switch owns the header's strip. */
  host?: SettingsTabHostProps
  scope: SecretPageScope
  /**
   * The team a team-scope panel reads and writes. Named explicitly by the page
   * that shows the team — Keys at `?scope=team:<id>` — never taken from the
   * session's current team: a team's keys are that team's, whichever team the
   * person is working in.
   */
  teamId?: string
}

export type SecretsPageWindow = {
  /** The page actually shown, which is not always the page that was stored. */
  page: number
  pageCount: number
  /** "1–25 of 40", or "No secrets" when the tab holds none. */
  label: string
  /** The slice bounds for `Array.prototype.slice`. */
  start: number
  end: number
}

/**
 * Which rows one page of a tab shows, and what its footer says.
 *
 * The stored page is clamped on read rather than written back clamped:
 * revoking the last secret on the final page moves it to the other tab, and a
 * stored page past the end would draw an empty table under a live Previous
 * button with nothing behind it. Reading it this way also means returning to a
 * tab lands on the page the reader left, whenever that page still exists.
 */
export const secretsPageWindow = (
  total: number,
  storedPage: number,
  pageSize: number,
): SecretsPageWindow => {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(storedPage, 0), pageCount - 1)
  const start = page * pageSize
  const end = Math.min(start + pageSize, total)
  return {
    end,
    label: total === 0 ? 'No secrets' : `${start + 1}–${end} of ${total}`,
    page,
    pageCount,
    start,
  }
}

/**
 * The single Secrets page, used at personal, team and organisation scope — laid
 * out like the Agents list, which is the admin's reference for a tabbed list:
 * one header carrying the title, the description, the action and the tab strip
 * with its counts; the bare table alone in the scroll area; and the shared
 * `PaginationFooter` pinned under it. The three differ only in which rows they
 * show, which scope "New secret" writes into, and whether a Scope column earns
 * its place.
 *
 * **Paging is client-side, as it is on Agents.** `GET /api/secrets` returns
 * every secret the viewer can see in one response and must: precedence is
 * resolved across the whole cascade, so a server page of rows could not say
 * which of them is the effective one. The footer still carries the shared
 * contract — Page X of Y, the result range and the 10/25/50/100 picker.
 */
export const SecretsPanel = ({ host, scope, teamId: namedTeamId }: SecretsPanelProps) => {
  const { data: secrets = [], isLoading } = useSecrets()
  const { data: projects = [] } = useProjects()
  const { me } = useAuthSession()
  const userId = me?.user.id ?? ''
  // Keys names its team in the address; the personal page resolves the
  // cascade that reaches the person, through the team they are working in.
  const teamId = (scope === 'team' ? namedTeamId : undefined) ?? me?.context.teamId ?? ''
  const projectId = me?.context.projectId ?? ''
  const createSecret = useCreateSecret()
  const revokeSecret = useRevokeSecret()
  // `status`, not `tab`: the strip narrows the list rather than switching a
  // section, and a host keeps `tab` (and Keys `scope`) for its own strip.
  const [tab, setTab] = useTabParam('status', SECRETS_TABS, 'active')
  const [createOpen, setCreateOpen] = useState(false)
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null)
  // Per tab, so switching strips does not land a reader on page 4 of a list
  // that has one page, and returning to a tab keeps the page they left on.
  const [pageByTab, setPageByTab] = useState<Record<SecretsTab, number>>({ active: 0, revoked: 0 })
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_LIMIT)
  const copy = COPY[scope]
  // The level this page writes into. Personal needs none — the API binds a
  // personal secret to the caller — and a project secret names its own.
  const pageScopeId = scope === 'team'
    ? teamId
    : scope === 'organization'
      ? me?.context.organizationId ?? ''
      : ''

  const rowsByTab = useMemo(() => {
    const resolved = resolveSecretRows(secrets, scope, { projectId, teamId, userId })
    return {
      active: resolved.filter((secret) => secretMatchesTab(secret, 'active')),
      revoked: resolved.filter((secret) => secretMatchesTab(secret, 'revoked')),
    }
  }, [projectId, scope, secrets, teamId, userId])

  const tabRows = rowsByTab[tab]
  const { end, label, page, pageCount, start } = secretsPageWindow(
    tabRows.length,
    pageByTab[tab],
    pageSize,
  )
  const pageRows = tabRows.slice(start, end)

  const revoke = async (reference: string) => {
    setFeedback(null)
    try {
      await revokeSecret.mutateAsync(reference)
      setFeedback({ kind: 'success', message: 'Secret revoked.' })
      setPendingRevoke(null)
    } catch (caught) {
      setFeedback({ kind: 'error', message: caught instanceof Error ? caught.message : 'Could not revoke secret.' })
    }
  }

  const tabItems: ReadonlyArray<TabBarItem<SecretsTab>> = SECRETS_TABS.map((value) => ({
    count: rowsByTab[value].length,
    label: TAB_LABEL[value],
    value,
  }))
  const statusStrip = (
    <TabBar
      ariaLabel="Secret status"
      idPrefix={`secrets-${scope}`}
      items={tabItems}
      onChange={setTab}
      value={tab}
    />
  )

  return (
    <SettingsPanel
      actions={[
        {
          id: 'new-secret',
          label: 'New secret',
          onSelect: () => {
            setFeedback(null)
            setCreateOpen(true)
          },
          primary: true,
          priority: 100,
        } satisfies PageHeaderAction,
      ]}
      eyebrow={copy.eyebrow}
      host={host}
      footer={
        // Always visible, as on Agents: an empty or single-page tab keeps its
        // size control, and the table above it does not jump as pages change.
        <PaginationFooter
          canNext={page < pageCount - 1}
          canPrevious={page > 0}
          label={label}
          onPageChange={(next) => setPageByTab((previous) => ({ ...previous, [tab]: next }))}
          onPageSizeChange={(next) => {
            setPageSize(next)
            setPageByTab({ active: 0, revoked: 0 })
          }}
          page={page}
          pageCount={pageCount}
          pageSize={pageSize}
        />
      }
      subtitle={
        <div className="grid gap-1">
          <p className="text-sm text-[color:var(--tx2)]">{copy.intro}</p>
          <p className="text-sm text-[color:var(--tx3)]">
            Values go directly to Infisical and are never displayed here. Copy a secret key or
            reference when you need to bind it elsewhere.
          </p>
          <p className="text-sm text-[color:var(--tx3)]">{copy.cascade}</p>
        </div>
      }
      tabs={statusStrip}
      title={copy.title}
    >
      <div className="space-y-5">
        {/* A host's own strip takes the header's tabs slot; the status strip
            then leads the body instead of stacking a second bar up there. */}
        {host?.tabs ? statusStrip : null}
        <FeedbackBanner feedback={feedback} />
        {/* The table owns its own frame and is never wrapped in a card
            (docs/standards/design-system.md → no nesting), which is also what
            gives the empty state room to breathe rather than pinning it to a
            card's inner edge. */}
        <section
          aria-labelledby={`secrets-${scope}-tab-${tab}`}
          id={`secrets-${scope}-tabpanel-${tab}`}
          role="tabpanel"
        >
          <SecretMetadataTable
            isLoading={isLoading}
            onRevoke={(reference) => setPendingRevoke(reference)}
            pageScope={scope}
            revokingReference={revokeSecret.isPending ? revokeSecret.variables : null}
            rows={pageRows}
            tab={tab}
          />
        </section>
      </div>
      <CreateSecretDialog
        onClose={() => setCreateOpen(false)}
        onCreate={(input) => createSecret.mutateAsync(input)}
        onSaved={() => {
          setCreateOpen(false)
          setFeedback({ kind: 'success', message: 'Saved to the vault. Nessie retained only its metadata.' })
        }}
        open={createOpen}
        pageScope={scope}
        pending={createSecret.isPending}
        projects={projects}
        scopeId={pageScopeId}
      />
      <ConfirmDialog
        body="Anything still using this secret reference will stop working."
        confirmLabel="Revoke secret"
        destructive
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) void revoke(pendingRevoke)
        }}
        open={pendingRevoke != null}
        pending={revokeSecret.isPending}
        title="Revoke this secret?"
      />
    </SettingsPanel>
  )
}
