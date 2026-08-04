import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type {
  DeepWaterAgentAccessTarget,
  IntegratedProductResponse,
} from '../../../lib/api-client'
import {
  useDeepWaterAgentAccess,
  useDeepWaterResearchRuns,
  useSetDeepWaterAgentAccess,
} from '../../../facades/integrations/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { DeepWaterResearchLauncher } from './DeepWaterResearchLauncher'
import { DeepWaterRunHistory } from './DeepWaterRunHistory'
import { IntegrationTabs } from './IntegrationTabs'

type DeepWaterTab = 'run' | 'runs' | 'settings'

const tabs: Array<{ id: DeepWaterTab; label: string }> = [
  { id: 'run', label: 'Test run' },
  { id: 'runs', label: 'My runs' },
  { id: 'settings', label: 'Settings' },
]

const readinessClass = (ready: boolean): string =>
  [
    'rounded px-2 py-0.5 text-[11px] font-semibold',
    ready
      ? 'bg-[var(--success-soft)] text-[var(--success-text)]'
      : 'bg-[var(--warning-soft)] text-[var(--warning-text)]',
  ].join(' ')

const accessTargetLabel = (target: DeepWaterAgentAccessTarget): string =>
  target.agentKind === 'personal_assistant' ? 'Personal Assistant' : target.name

const launchReadinessMessage = ({
  connectorReady,
  personalAssistantReady,
  teamReady,
}: {
  connectorReady: boolean
  personalAssistantReady: boolean
  teamReady: boolean
}): string | undefined => {
  if (!teamReady) return 'An organization owner must enable Deep Water for this team first.'
  if (!connectorReady) return 'The team’s Ledger MCP connector is not active yet.'
  if (!personalAssistantReady) {
    return 'An organization owner must grant the Personal Assistant all six Deep Water tools.'
  }
  return undefined
}

type DeepWaterResearchPanelProps = {
  product: IntegratedProductResponse
  settingsContent: ReactNode
}

// The product detail used to combine launch controls, history, permissions, and
// setup in one long section. Keep their data/hooks together, but present each
// task on its own tab so operators can understand the workflow at a glance.
export const DeepWaterResearchPanel = ({
  product,
  settingsContent,
}: DeepWaterResearchPanelProps) => {
  const navigate = useNavigate()
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const [activeTab, setActiveTab] = useState<DeepWaterTab>('run')
  const runsQuery = useDeepWaterResearchRuns()
  const accessQuery = useDeepWaterAgentAccess()
  const setAgentAccess = useSetDeepWaterAgentAccess()
  const teamReady = product.teamEnablement?.enabled === true
  const connectorReady = product.mcpInstallation?.lifecycleState === 'active'
  const personalAssistantReady = accessQuery.data?.personalAssistant?.enabled === true
  const canLaunch = teamReady && connectorReady && personalAssistantReady
  const accessTargets = [
    ...(accessQuery.data?.personalAssistant ? [accessQuery.data.personalAssistant] : []),
    ...(accessQuery.data?.sharedAgents ?? []),
  ]

  const changeAccess = (
    target: DeepWaterAgentAccessTarget | null,
    enabled: boolean,
  ) => {
    if (target?.agentKind === 'shared') {
      setAgentAccess.mutate({ agentId: target.agentId, enabled, target: 'agent' })
      return
    }
    setAgentAccess.mutate({ enabled, target: 'personal_assistant' })
  }

  return (
    <section className="border-t border-[var(--sep)] pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--tx)]">Deep Water research</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">
            Start research, follow your team’s durable runs, and manage access separately.
          </p>
        </div>
        <Link className="text-xs text-[var(--tx3)] underline" to="/tokens">
          Team credits and customer totals
        </Link>
      </div>

      <div className="mt-4">
        <IntegrationTabs activeTab={activeTab} onSelect={(tab) => setActiveTab(tab as DeepWaterTab)} tabs={tabs} />
      </div>

      {activeTab === 'run' ? (
        <div
          aria-labelledby="integration-tab-run"
          className="mt-4"
          id="integration-tabpanel-run"
          role="tabpanel"
        >
          <div className="mb-4 rounded border border-[var(--sep)] bg-[var(--overlay-weak)] px-3 py-2 text-sm leading-6 text-[var(--tx2)]">
            This starts a real Deep Water research job. Choose a template to set the controls,
            then review or adjust every value before submitting.
          </div>
          <DeepWaterResearchLauncher
            canLaunch={canLaunch}
            onLaunched={(response) => navigate(`/channels/${response.channel.id}`)}
            readinessMessage={
              accessQuery.isLoading
                ? 'Checking Deep Water access…'
                : launchReadinessMessage({ connectorReady, personalAssistantReady, teamReady })
            }
          />
        </div>
      ) : null}

      {activeTab === 'runs' ? (
        <div
          aria-labelledby="integration-tab-runs"
          id="integration-tabpanel-runs"
          role="tabpanel"
        >
          <DeepWaterRunHistory loading={runsQuery.isLoading} runs={runsQuery.data ?? []} />
        </div>
      ) : null}

      {activeTab === 'settings' ? (
        <div
          aria-labelledby="integration-tab-settings"
          className="mt-4 grid gap-4"
          id="integration-tabpanel-settings"
          role="tabpanel"
        >
          <section className="rounded border border-[var(--sep)] p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-[var(--tx)]">Research readiness</h4>
                <p className="mt-1 text-xs leading-5 text-[var(--tx3)]">
                  The Personal Assistant needs all six explicit Deep Water grants before it can
                  start a research job.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className={readinessClass(teamReady)}>
                  {teamReady ? 'Team enabled' : 'Team disabled'}
                </span>
                <span className={readinessClass(connectorReady)}>
                  {connectorReady ? 'MCP active' : 'MCP setup required'}
                </span>
                <span className={readinessClass(product.accountLink?.status === 'linked')}>
                  {product.accountLink?.status === 'linked' ? 'Account linked' : 'Account pending'}
                </span>
                <span className={readinessClass(personalAssistantReady)}>
                  {personalAssistantReady ? 'Personal Assistant granted' : 'Agent grant required'}
                </span>
              </div>
            </div>
          </section>

          <section className="rounded border border-[var(--sep)] p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-[var(--tx)]">Agent access</h4>
                <p className="mt-1 text-xs leading-5 text-[var(--tx3)]">
                  Grants are explicit, per agent, and remain subject to team and user tenancy.
                </p>
              </div>
              {isOwner ? (
                <Link
                  className="admin-button admin-button-secondary admin-button-compact"
                  to={`/agents/tools?deepWaterInstance=${product.mcpInstallation?.id ?? ''}`}
                >
                  Manage individual tools
                </Link>
              ) : null}
            </div>

            {accessQuery.isLoading ? (
              <div className="mt-3 text-xs text-[var(--tx3)]">Checking agent access…</div>
            ) : accessQuery.isError ? (
              <div className="mt-3 text-xs text-[var(--danger-text)]">
                Could not check agent access.{' '}
                <button className="underline" onClick={() => void accessQuery.refetch()} type="button">
                  Retry
                </button>
              </div>
            ) : (
              <div className="mt-3 divide-y divide-[var(--sep)] overflow-hidden rounded border border-[var(--sep)]">
                {accessTargets.map((target) => {
                  const canRevoke = target.revocableGrantCount > 0
                  const pending = setAgentAccess.isPending && (
                    setAgentAccess.variables?.target === 'personal_assistant'
                      ? target.agentKind === 'personal_assistant'
                      : setAgentAccess.variables?.agentId === target.agentId
                  )
                  return (
                    <div className="flex items-center justify-between gap-3 px-3 py-2" key={target.agentId}>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[var(--tx)]">
                          {accessTargetLabel(target)}
                        </div>
                        <div className="text-xs text-[var(--tx3)]">
                          {target.grantedToolCount}/{target.requiredToolCount} tools granted
                        </div>
                      </div>
                      {isOwner ? (
                        <button
                          className={[
                            'admin-button admin-button-compact',
                            canRevoke ? 'admin-button-secondary' : 'admin-button-primary',
                          ].join(' ')}
                          disabled={pending || (!canRevoke && accessQuery.data?.configured !== true)}
                          onClick={() => changeAccess(target, !canRevoke)}
                          type="button"
                        >
                          {pending ? 'Saving…' : canRevoke ? 'Revoke all' : 'Grant all'}
                        </button>
                      ) : null}
                    </div>
                  )
                })}
                {!accessQuery.data?.personalAssistant && isOwner ? (
                  <div className="flex items-center justify-between gap-3 px-3 py-2">
                    <div>
                      <div className="text-sm font-medium text-[var(--tx)]">Personal Assistant</div>
                      <div className="text-xs text-[var(--tx3)]">Set up and grant all six tools</div>
                    </div>
                    <button
                      className="admin-button admin-button-primary admin-button-compact"
                      disabled={setAgentAccess.isPending || accessQuery.data?.configured !== true}
                      onClick={() => changeAccess(null, true)}
                      type="button"
                    >
                      {setAgentAccess.isPending ? 'Saving…' : 'Set up & grant'}
                    </button>
                  </div>
                ) : null}
              </div>
            )}
            {!isOwner && !personalAssistantReady ? (
              <p className="mt-2 text-xs text-[var(--tx3)]">
                An organization owner must grant Deep Water to the Personal Assistant.
              </p>
            ) : null}
            {setAgentAccess.isError ? (
              <p className="mt-2 text-xs text-[var(--danger-text)]">
                {setAgentAccess.error instanceof Error
                  ? setAgentAccess.error.message
                  : 'Could not change agent access.'}
              </p>
            ) : null}
          </section>

          {settingsContent}
        </div>
      ) : null}
    </section>
  )
}
