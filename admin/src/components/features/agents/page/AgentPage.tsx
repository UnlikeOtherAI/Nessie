import { useMemo, useState } from 'react'
import { useAgentDocuments } from '../../../../facades/agents/hooks'
import type { AgentRecord } from '../../../../lib/api-client'
import { useTabParam } from '../../../../navigation/useTabParam'
import { Skeleton } from '../../../primitives/Skeleton'
import { TabBar } from '../../../primitives/TabBar'
import { PageBody } from '../../../shared/PageBody'
import { useCanEditAgent } from '../agent-edit-authority'
import { AgentTriggerPanel } from '../AgentTriggerPanel'
import { DesignerAssistantDock } from '../designer/DesignerAssistantDock'
import { DesignerAssistantPanelProvider } from '../designer/DesignerAssistantPanelContext'
import { DesignerChat } from '../designer/DesignerChat'
import { AgentAboutTab } from './AgentAboutTab'
import { AgentAccessTab } from './AgentAccessTab'
import { AgentActivityTab } from './AgentActivityTab'
import { AgentInstructionsTab } from './AgentInstructionsTab'
import { AgentPageHeader } from './AgentPageHeader'
import { AgentSaveBar } from './AgentSaveBar'
import { AgentSettingsTab } from './AgentSettingsTab'
import {
  agentPageAssistantContext,
  agentPageTabItems,
  agentPageTabs,
  isBuiltInAgent,
} from './agent-page-tabs'
import { useAgentConfigForm, type AgentCoreDocument } from './useAgentConfigForm'
import { useAgentDesignAssistant } from './useAgentDesignAssistant'

type ReadyProps = {
  agent: AgentRecord
  builtIn: boolean
  canEdit: boolean
  coreDocuments?: readonly AgentCoreDocument[]
  documents?: ReturnType<typeof useAgentDocuments>
  onBack: () => void
}

/**
 * The page once the agent's core documents are known. The form's reducer
 * starts from them exactly once, so it mounts only after they have arrived —
 * starting it from the record and patching it later would count the published
 * instructions as an unsaved edit.
 */
const AgentPageReady = ({ agent, builtIn, canEdit, coreDocuments, documents, onBack }: ReadyProps) => {
  const tabs = useMemo(() => agentPageTabs(agent), [agent])
  const [tab, selectTab] = useTabParam('tab', tabs, 'about')
  const form = useAgentConfigForm({ agent, coreDocuments })
  const assistant = useAgentDesignAssistant({
    agentId: agent.id,
    form,
    pageContext: agentPageAssistantContext(tab),
    showTab: selectTab,
  })
  const [dockOpen, setDockOpen] = useState(true)
  const manages = canEdit && !builtIn
  const formTab = tab === 'instructions' || tab === 'settings'

  const body = (() => {
    switch (tab) {
      case 'instructions':
        return (
          <AgentInstructionsTab
            agent={agent}
            builtIn={builtIn}
            canEdit={canEdit}
            {...(documents ? { documents } : {})}
            form={form}
            onSelectTab={selectTab}
          />
        )
      case 'access':
        return <AgentAccessTab agent={agent} builtIn={builtIn} canEdit={canEdit} />
      case 'schedule':
        return <PageBody><AgentTriggerPanel agent={agent} /></PageBody>
      case 'activity':
        return <AgentActivityTab agent={agent} />
      case 'settings':
        return <AgentSettingsTab agent={agent} builtIn={builtIn} canEdit={canEdit} form={form} />
      default:
        return (
          <AgentAboutTab agent={agent} builtIn={builtIn} canEdit={canEdit} form={form} onSelectTab={selectTab} />
        )
    }
  })()

  return (
    <div className="flex h-full min-w-0 flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AgentPageHeader
          agent={agent}
          avatarContext={{
            name: form.state.name,
            role: form.state.role.trim() || 'assistant',
            systemPrompt: form.state.systemPrompt,
          }}
          builtIn={builtIn}
          canEdit={canEdit}
          onBack={onBack}
          tabs={
            <TabBar
              ariaLabel="Agent sections"
              items={agentPageTabItems(tabs)}
              onChange={selectTab}
              value={tab}
            />
          }
        />
        {manages && formTab ? <AgentSaveBar form={form} onSave={() => void form.save()} /> : null}
        <div className="flex min-h-0 flex-1 flex-col" data-testid={`agent-tab-${tab}`}>{body}</div>
      </div>
      {manages ? (
        <DesignerAssistantDock onOpen={() => setDockOpen(true)} open={dockOpen}>
          <DesignerChat
            continuingInChat={assistant.continuingInChat}
            error={assistant.chat.error}
            messages={assistant.chat.messages}
            onClose={() => setDockOpen(false)}
            onContinueInChat={assistant.onContinueInChat}
            onSend={(message) => void assistant.chat.send(message)}
            onStop={assistant.chat.stop}
            pageContext={agentPageAssistantContext(tab)}
            status={assistant.chat.status}
            streaming={assistant.chat.streaming}
            thinking={assistant.chat.thinking}
          />
        </DesignerAssistantDock>
      ) : null}
    </div>
  )
}

/**
 * One agent: About · Instructions · Access · Schedule · Activity · Settings
 * (docs/plans/2026-09-26-admin-ux-overhaul.md §6.3). Whoever manages the
 * agent edits it in place, with the Design Assistant docked beside every tab;
 * anybody else reads the same tabs with nothing to change and the way to a
 * copy of their own; a built-in agent shows only the tabs that work for it.
 */
export const AgentPage = ({ agent, onBack }: { agent: AgentRecord; onBack: () => void }) => {
  const canEdit = useCanEditAgent(agent)
  const builtIn = isBuiltInAgent(agent)
  // A built-in agent's document read is closed; its instructions come from
  // the record it ships with.
  const documents = useAgentDocuments(builtIn ? undefined : agent.id)

  if (!builtIn && documents.isPending) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <AgentPageHeader agent={agent} builtIn={builtIn} canEdit={canEdit} onBack={onBack} />
        <PageBody><Skeleton variant="detail" /></PageBody>
      </div>
    )
  }

  return (
    <DesignerAssistantPanelProvider>
      <AgentPageReady
        agent={agent}
        builtIn={builtIn}
        canEdit={canEdit}
        {...(documents.data?.coreDocuments ? { coreDocuments: documents.data.coreDocuments } : {})}
        {...(builtIn ? {} : { documents })}
        key={agent.id}
        onBack={onBack}
      />
    </DesignerAssistantPanelProvider>
  )
}
