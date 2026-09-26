import { useState } from 'react'
import type { AgentRecord } from '../../../../lib/api-client'
import { useTabParam } from '../../../../navigation/useTabParam'
import type { PageHeaderAction } from '../../../shared/ResponsivePageHeader'
import { PageBody, Section } from '../../../shared/PageBody'
import { ScreenHeader } from '../../../shared/ScreenHeader'
import { AgentAvatarDraftPanel } from '../AgentAvatarDraftPanel'
import { AgentCreationModeTabs, CREATION_MODE_VALUES } from '../designer/AgentCreationModeTabs'
import { DesignerAssistantDock } from '../designer/DesignerAssistantDock'
import { DesignerChat } from '../designer/DesignerChat'
import { NewAgentTools } from './AgentAccessTab'
import {
  AgentInstructionsField,
  AgentMannerFields,
  AgentModelFields,
  AgentNameRoleFields,
  AgentTodosSetting,
  AgentVisibilityField,
} from './AgentConfigFields'
import { NEW_AGENT_ASSISTANT_CONTEXT } from './agent-page-tabs'
import { useAgentConfigForm } from './useAgentConfigForm'
import { useAgentDesignAssistant } from './useAgentDesignAssistant'
import { useIsOwner } from '../../../../facades/auth/hooks'

type NewAgentFlowProps = {
  /** Leaves the flow for wherever the person came from. */
  onBack: () => void
  /** The agent exists: its own page takes over. */
  onCreated: (agent: AgentRecord) => void
}

/**
 * New agent, at `/admin/agents/new`: the agent page before there is an agent.
 *
 * Create is prompt-first — the Design Assistant asks what the agent is for and
 * fills the draft in. Configure is the same draft as the page's own fields, in
 * the order a new agent needs them: who it is, what runs it, what it is told,
 * and what it may use. Both stay mounted over one form, so moving between them
 * never loses a word; Create agent saves it, and the new agent's page opens on
 * the very tabs these fields live on afterwards.
 */
export const NewAgentFlow = ({ onBack, onCreated }: NewAgentFlowProps) => {
  const isOwner = useIsOwner()
  const [mode, selectMode] = useTabParam('mode', CREATION_MODE_VALUES, 'create')
  const form = useAgentConfigForm({})
  // No tab to switch to: in Create the conversation stays on screen while the
  // draft fills in behind it, which is what Configure then reviews.
  const assistant = useAgentDesignAssistant({ form, pageContext: NEW_AGENT_ASSISTANT_CONTEXT })
  const [dockOpen, setDockOpen] = useState(true)

  const create = () => {
    void form.save().then((agent) => {
      if (agent) onCreated(agent)
    })
  }

  const actions: PageHeaderAction[] = [
    { id: 'cancel', label: 'Cancel', onSelect: onBack, priority: 60 },
    {
      disabled: form.blocker !== null || form.isSaving,
      id: 'create-agent',
      label: form.isSaving ? 'Creating…' : 'Create agent',
      onSelect: create,
      primary: true,
      priority: 100,
      ...(form.blocker ? { title: form.blocker } : {}),
    },
  ]

  const chat = (guided: boolean, onClose?: () => void) => (
    <DesignerChat
      continuingInChat={assistant.continuingInChat}
      error={assistant.chat.error}
      guidedCreation={guided}
      messages={assistant.chat.messages}
      {...(onClose ? { onClose } : {})}
      onContinueInChat={assistant.onContinueInChat}
      onSend={(message) => void assistant.chat.send(message)}
      onStop={assistant.chat.stop}
      pageContext={NEW_AGENT_ASSISTANT_CONTEXT}
      status={assistant.chat.status}
      streaming={assistant.chat.streaming}
      thinking={assistant.chat.thinking}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* A Flow that returns to an address the registry cannot know — wherever
          New agent was pressed — so it owns its Back on every layout. */}
      <ScreenHeader
        actions={actions}
        backLabel="Back"
        flowOwnsBack
        onBack={onBack}
        tabs={<AgentCreationModeTabs onChange={selectMode} value={mode} />}
        title="New agent"
      />
      {/* The blocked Create is in the header, so its reason sits right under it. */}
      {form.blocker || form.saveError ? (
        <p
          className={[
            'flex-shrink-0 border-b border-[color:var(--sep)] bg-[color:var(--overlay-weak)]',
            'px-[var(--page-gutter)] py-2 text-xs',
            form.saveError ? 'text-[color:var(--danger-text)]' : 'text-[color:var(--tx2)]',
          ].join(' ')}
          role={form.saveError ? 'alert' : 'status'}
        >
          {form.saveError ?? form.blocker}
        </p>
      ) : null}
      <div
        aria-labelledby="agent-creation-mode-tab-create"
        className="min-h-0 flex-1"
        hidden={mode !== 'create'}
        id="agent-creation-mode-tabpanel-create"
        role="tabpanel"
      >
        {chat(true)}
      </div>
      <div
        aria-labelledby="agent-creation-mode-tab-configure"
        className="flex min-h-0 flex-1 flex-col lg:flex-row"
        hidden={mode !== 'configure'}
        id="agent-creation-mode-tabpanel-configure"
        role="tabpanel"
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <PageBody>
            <AgentAvatarDraftPanel
              avatarAttachmentId={form.avatarAttachmentId}
              name={form.state.name}
              onAvatarAttachmentChange={form.setAvatarAttachmentId}
              role={form.state.role.trim() || 'assistant'}
            />
            <Section title="Name and role">
              <AgentNameRoleFields form={form} readOnly={false} />
            </Section>
            <Section title="Visibility">
              <AgentVisibilityField form={form} readOnly={false} />
            </Section>
            <Section title="Model and limits">
              <AgentModelFields form={form} readOnly={false} />
            </Section>
            <Section title="Instructions">
              <AgentInstructionsField form={form} readOnly={false} />
            </Section>
            <Section title="Manner">
              <AgentMannerFields form={form} readOnly={false} />
            </Section>
            <Section
              description="Built-in tools are on unless you switch them off; connected apps and protected tools start off."
              title="Tools and apps"
            >
              <NewAgentTools form={form} />
            </Section>
            <Section title="To-dos">
              <AgentTodosSetting canManageTodos={isOwner} form={form} readOnly={false} />
            </Section>
          </PageBody>
        </div>
        <DesignerAssistantDock onOpen={() => setDockOpen(true)} open={dockOpen}>
          {chat(false, () => setDockOpen(false))}
        </DesignerAssistantDock>
      </div>
    </div>
  )
}
