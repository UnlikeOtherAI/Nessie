import { Link } from 'react-router-dom'
import { useIsOwner } from '../../../../facades/auth/hooks'
import type { AgentRecord } from '../../../../lib/api-client'
import { COMPUTERS_PATH } from '../../../../navigation/computers'
import { PageBody, Section } from '../../../shared/PageBody'
import { AgentBrowserPanel } from '../../browser-cloud/AgentBrowserPanel'
import { AgentAvailableTools } from '../AgentAvailableTools'
import { AgentEmailSection } from '../AgentEmailSection'
import { ToolPicker } from '../designer/ToolPicker'
import { BuiltInAgentNote } from './BuiltInAgentNote'
import type { AgentConfigForm } from './useAgentConfigForm'

const linkClass = 'text-[color:var(--lnk)] hover:underline'

/**
 * A new agent's tools are part of its form, so the create flow switches them
 * in the same picker the Access tab uses and they are saved with Create.
 */
export const NewAgentTools = ({ form }: { form: AgentConfigForm }) => (
  <ToolPicker
    groups={form.toolCatalog.groups}
    onToggle={form.actions.toggleTool}
    query={form.toolCatalog}
    toolState={form.state.tools}
  />
)

type AgentAccessTabProps = {
  agent: AgentRecord
  builtIn: boolean
  canEdit: boolean
}

/**
 * Access: everything this agent may use, one kind per section — the tools and
 * apps it may call (grouped by category, every group closed at rest), its
 * cloud browser, its email address, and where the grants that live on another
 * object are made: a computer's own Agents tab, an app's Agents with access,
 * the research service's page. Those rows become one shared control on both
 * sides when the connection pages land; until then the doorway is the answer.
 */
export const AgentAccessTab = ({ agent, builtIn, canEdit }: AgentAccessTabProps) => {
  // Claiming, changing and deleting an agent's address are the organisation
  // owner's (the mailbox routes' `requireOwner`), whoever else may edit it.
  const isOwner = useIsOwner()
  return (
    <PageBody>
      {builtIn ? <BuiltInAgentNote /> : null}
      <Section
        description={canEdit
          ? 'Switch tools and connected apps on or off, then save. Cloud browser, project and other protected tools are an organisation owner’s to grant.'
          : 'The tools and connected apps this agent may use. Only someone who manages it can change them.'}
        title="Tools and apps"
      >
        {/* Every agent's list goes through one component, read-only included, so
            a reader and an editor never see two different catalogues. */}
        <AgentAvailableTools agent={agent} editable={!builtIn} />
      </Section>

      {builtIn ? null : (
        <Section title="Cloud browser">
          {agent.browserEnabled ? (
            <AgentBrowserPanel agent={agent} heading={false} />
          ) : (
            <p className="text-sm text-[color:var(--tx2)]">
              This agent has no browser. An organisation owner turns one on with the
              browser tools under Tools and apps.
            </p>
          )}
        </Section>
      )}

      {builtIn ? null : (
        <Section title="Email address">
          <AgentEmailSection agentId={agent.id} canManage={isOwner} />
        </Section>
      )}

      {builtIn ? null : (
        <Section title="Computers, apps and research">
          <ul className="grid gap-2 text-sm text-[color:var(--tx2)]">
            <li>
              Which computers it may work on is chosen on each computer’s Agents tab.{' '}
              <Link className={linkClass} to={COMPUTERS_PATH}>Open Computers</Link>
            </li>
            <li>
              Which connected apps it may use is chosen on each app’s Agents with access.{' '}
              <Link className={linkClass} to="/admin/apps">Open Apps</Link>
            </li>
            <li>
              Research is granted on the research service’s page.{' '}
              <Link className={linkClass} to="/admin/apps/deep-water?tab=agents">Open research</Link>
            </li>
          </ul>
        </Section>
      )}
    </PageBody>
  )
}
