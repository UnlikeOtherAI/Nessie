import { useLocation, useNavigate } from 'react-router-dom'
import type {
  AgentRecord,
  ChannelRecord,
  PersonalAssistantPresenceParticipant,
  UserRecord,
} from '../../../../lib/api-client'
import { getConversationRoute } from '../../../../lib/conversation-navigation'
import { useNavigationLayout } from '../../../../navigation/mobile-shell'
import { Sheet } from '../../../overlays/Sheet'
import { TabBar } from '../../../primitives/TabBar'
import { PageBody } from '../../../shared/PageBody'
import type { PageHeaderAction } from '../../../shared/ResponsivePageHeader'
import { ScreenHeader } from '../../../shared/ScreenHeader'
import { ChannelAutomationsPanel } from '../ChannelAutomationsPanel'
import type { ChatTool, ChatToolId } from '../tool-rail/chat-tools'
import { DetailsAgents } from './DetailsAgents'
import { DetailsGeneral } from './DetailsGeneral'
import { DetailsNotifications } from './DetailsNotifications'
import { DetailsAddPeople, DetailsPeople, canAddPeople } from './DetailsPeople'
import { DetailsResponses } from './DetailsResponses'
import { DETAILS_SECTION_LABELS, detailsSections, isRoom } from './details-sections'
import { useDetailsSection } from './useDetailsSection'

type ConversationDetailsProps = {
  /** The tools this conversation's agents have (`availableChatTools`). */
  agentTools: readonly ChatTool[]
  /** Every agent that may be placed in a channel, global ones included. */
  agents: AgentRecord[]
  allUsers: UserRecord[]
  boundAgents: AgentRecord[]
  channel: ChannelRecord
  channelUsers: UserRecord[]
  currentUserId: string
  /**
   * The route's own Back (`performRouteBack`), handed down by the page that
   * owns the navigation controller: every way out of Details — the header's
   * Back, Escape, the sheet's scrim, a swipe — is that one Back.
   */
  onClose: () => void
  onOpenTool: (tool: ChatToolId) => void
  personalAssistantPresences: PersonalAssistantPresenceParticipant[]
  threadId: string | null
}

/**
 * A conversation's Details (plan §6.6): one panel for every conversation but
 * the Personal Assistant's home, opened by the header's gear, by its Members
 * count and by the three `/info` routes, which stay routes for Back and deep
 * links. Its sections are `details-sections.ts`'s.
 *
 * On `single` it is the pushed screen itself — the page renders it in place
 * of the conversation — so the stack slides it, the one header's doorway is
 * Back and the edge swipe works. On `split` the route renders inside the
 * conversation's own page (`splitInline`), and Details is a right-hand
 * `Sheet` over it: an overlay that belongs to its layer
 * (docs/navigation/overlays.md), so a screen pushed from inside it (an
 * agent's page, a computer) covers it and Back brings it back as it was.
 * It is the same component on both, as the compose flow is.
 */
export const ConversationDetails = ({
  agentTools,
  agents,
  allUsers,
  boundAgents,
  channel,
  channelUsers,
  currentUserId,
  onClose,
  onOpenTool,
  personalAssistantPresences,
  threadId,
}: ConversationDetailsProps) => {
  const location = useLocation()
  const navigate = useNavigate()
  const layout = useNavigationLayout()
  const route = getConversationRoute(location.pathname)
  const open = route !== null && route.channelId === channel.id && route.step !== 'conversation'
  const offered = detailsSections(channel)
  const [section, selectSection] = useDetailsSection(channel.id, offered)
  const adding = route?.step === 'add-members'

  const addPeopleAction: PageHeaderAction[] | undefined =
    section === 'people' && !adding && canAddPeople(channel)
      ? [{
          id: 'add-people',
          label: 'Add people',
          onSelect: () => void navigate(`/channels/${channel.id}/info/members/add${location.search}`),
          primary: true,
          priority: 100,
        }]
      : undefined

  const body = adding ? (
    <DetailsAddPeople allUsers={allUsers} channel={channel} channelUsers={channelUsers} currentUserId={currentUserId} />
  ) : section === 'people' ? (
    <DetailsPeople channel={channel} channelUsers={channelUsers} currentUserId={currentUserId} />
  ) : section === 'agents' ? (
    <DetailsAgents
      agents={agents}
      boundAgents={boundAgents}
      channel={channel}
      currentUserId={currentUserId}
      personalAssistantPresences={personalAssistantPresences}
    />
  ) : section === 'notifications' ? (
    <DetailsNotifications channel={channel} />
  ) : section === 'responses' ? (
    // Keyed by the room: another room's policy is never this one's edit.
    <DetailsResponses boundAgents={boundAgents} channel={channel} key={channel.id} />
  ) : section === 'automations' ? (
    <ChannelAutomationsPanel channelId={channel.id} />
  ) : (
    <DetailsGeneral
      agentCount={boundAgents.length}
      agentTools={agentTools}
      channel={channel}
      onOpenFiles={() => void navigate(`/channels/${channel.id}?tab=files`)}
      onOpenTool={onOpenTool}
      peopleCount={channelUsers.length}
      threadId={threadId}
    />
  )

  const title = adding ? 'Add people' : 'Details'
  const panel = (
    <section
      aria-label={title}
      className="flex h-full min-h-0 w-full flex-col bg-[color:var(--main)] data-[layout=split]:border-l data-[layout=split]:border-[color:var(--sep)]"
      data-layout={layout}
      data-testid="conversation-details"
    >
      <ScreenHeader
        actions={addPeopleAction}
        backLabel={adding ? 'Back to People' : 'Back to conversation'}
        eyebrow={isRoom(channel) ? `#${channel.label}` : channel.label}
        onBack={onClose}
        tabs={adding ? undefined : (
          <TabBar
            ariaLabel="Details sections"
            idPrefix="conversation-details"
            items={offered.map((value) => ({ label: DETAILS_SECTION_LABELS[value], value }))}
            onChange={selectSection}
            role="tablist"
            size="sm"
            value={section}
          />
        )}
        title={title}
      />
      <PageBody>
        <div
          aria-labelledby={adding ? undefined : `conversation-details-tab-${section}`}
          id={adding ? undefined : `conversation-details-tabpanel-${section}`}
          role={adding ? undefined : 'tabpanel'}
        >
          {body}
        </div>
      </PageBody>
    </section>
  )

  if (layout === 'split') {
    return (
      <Sheet onClose={onClose} open={open} side="right" size="md" title={title}>
        {panel}
      </Sheet>
    )
  }
  return open ? panel : null
}
