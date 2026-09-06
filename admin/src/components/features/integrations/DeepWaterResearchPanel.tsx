import type { ReactNode } from 'react'
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
import { Notice } from '../../primitives/Notice'
import { Pill, type PillTone } from '../../primitives/Pill'
import { useTabParam } from '../../../navigation/useTabParam'
import { TabBar } from '../../primitives/TabBar'
import { QueryState } from '../../shared/QueryState'
import { useIsOwner } from '../../../facades/auth/hooks'
import { DeepWaterResearchLauncher } from './DeepWaterResearchLauncher'
import { DeepWaterRunHistory } from './DeepWaterRunHistory'

const DEEP_WATER_TABS = ['run', 'runs', 'settings'] as const

type DeepWaterTab = (typeof DEEP_WATER_TABS)[number]

const tabs: ReadonlyArray<{ label: string; value: DeepWaterTab }> = [
  { label: 'Test run', value: 'run' },
  { label: 'My runs', value: 'runs' },
  { label: 'Settings', value: 'settings' },
]

const readinessTone = (ready: boolean): PillTone => (ready ? 'success' : 'warning')

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
  const isOwner = useIsOwner()
  // `research`, not `tab`: this panel sits inside a product's detail on the
  // Integrations page, which owns the page-level strip.
  const [activeTab, setActiveTab] = useTabParam('research', DEEP_WATER_TABS, 'run')
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
    <section className="border-t border-[color:var(--sep)] pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[color:var(--tx)]">Deep Water research</h3>
          <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
            Start research, follow your team’s durable runs, and manage access separately.
          </p>
        </div>
        <Link className="text-xs text-[color:var(--tx3)] underline" to="/tokens">
          Team credits and customer totals
        </Link>
      </div>

      <div className="mt-4">
        <TabBar
          ariaLabel="Deep Water sections"
          idPrefix="integration"
          items={tabs}
          onChange={setActiveTab}
          value={activeTab}
        />
      </div>

      {activeTab === 'run' ? (
        <div
          aria-labelledby="integration-tab-run"
          className="mt-4"
          id="integration-tabpanel-run"
          role="tabpanel"
        >
          <Notice className="mb-4" tone="neutral">
            This starts a real Deep Water research job. Pick Light, Standard or Heavy to
            assume the settings, or Custom to review every value before submitting.
          </Notice>
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
          <QueryState
            className="py-8"
            errorLabel="Could not load Deep Water runs."
            loadingLabel="Loading runs…"
            query={runsQuery}
          >
            {() => <DeepWaterRunHistory runs={runsQuery.data ?? []} />}
          </QueryState>
        </div>
      ) : null}

      {activeTab === 'settings' ? (
        <div
          aria-labelledby="integration-tab-settings"
          className="mt-4 grid gap-4"
          id="integration-tabpanel-settings"
          role="tabpanel"
        >
          <section className="rounded-[var(--radius-md)] border border-[color:var(--sep)] p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-[color:var(--tx)]">Research readiness</h4>
                <p className="mt-1 text-xs leading-5 text-[color:var(--tx3)]">
                  The Personal Assistant needs all six explicit Deep Water grants before it can
                  start a research job.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Pill
                  className="font-semibold"
                  radius="chip"
                  size="sm"
                  tone={readinessTone(teamReady)}
                  uppercase={false}
                >
                  {teamReady ? 'Team enabled' : 'Team disabled'}
                </Pill>
                <Pill
                  className="font-semibold"
                  radius="chip"
                  size="sm"
                  tone={readinessTone(connectorReady)}
                  uppercase={false}
                >
                  {connectorReady ? 'MCP active' : 'MCP setup required'}
                </Pill>
                <Pill
                  className="font-semibold"
                  radius="chip"
                  size="sm"
                  tone={readinessTone(product.accountLink?.status === 'linked')}
                  uppercase={false}
                >
                  {product.accountLink?.status === 'linked' ? 'Account linked' : 'Account pending'}
                </Pill>
                <Pill
                  className="font-semibold"
                  radius="chip"
                  size="sm"
                  tone={readinessTone(personalAssistantReady)}
                  uppercase={false}
                >
                  {personalAssistantReady ? 'Personal Assistant granted' : 'Agent grant required'}
                </Pill>
              </div>
            </div>
          </section>

          <section className="rounded-[var(--radius-md)] border border-[color:var(--sep)] p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-[color:var(--tx)]">Agent access</h4>
                <p className="mt-1 text-xs leading-5 text-[color:var(--tx3)]">
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

            <QueryState
              className="mt-3 py-2"
              errorLabel="Could not check agent access."
              loadingLabel="Checking agent access…"
              query={accessQuery}
            >
              {() => (
                <div className="divide-y divide-[color:var(--sep)] overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--sep)]">
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
                          <div className="truncate text-sm font-medium text-[color:var(--tx)]">
                            {accessTargetLabel(target)}
                          </div>
                          <div className="text-xs text-[color:var(--tx3)]">
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
                        <div className="text-sm font-medium text-[color:var(--tx)]">Personal Assistant</div>
                        <div className="text-xs text-[color:var(--tx3)]">Set up and grant all six tools</div>
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
            </QueryState>
            {!isOwner && !personalAssistantReady ? (
              <p className="mt-2 text-xs text-[color:var(--tx3)]">
                An organization owner must grant Deep Water to the Personal Assistant.
              </p>
            ) : null}
            {setAgentAccess.isError ? (
              <Notice className="mt-2" role="alert" size="sm" tone="danger">
                {setAgentAccess.error instanceof Error
                  ? setAgentAccess.error.message
                  : 'Could not change agent access.'}
              </Notice>
            ) : null}
          </section>

          {settingsContent}
        </div>
      ) : null}
    </section>
  )
}
