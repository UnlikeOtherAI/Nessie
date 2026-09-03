import { useMemo } from 'react';
import { isExternalAgentChannel } from '../../facades/personal-assistant/channel-kinds';
import type { ResolvedChatAssistantSurface } from '../../facades/integrations/useProductSurfaces';
import type { AgentRecord, ChannelRecord, MeResponse, UserRecord } from '../../lib/api-client';
import {
  resolveAgentDms,
  resolvePeopleDirectory,
  resolvePeopleWithConversations,
} from './sidebar-dm-lists';
import type {
  SidebarAgentDm,
  SidebarGroupDm,
  SidebarPerson,
  SidebarProductAssistant,
} from './types';

type UseSidebarDmsInput = {
  agents: AgentRecord[];
  channels: ChannelRecord[];
  chatAssistants: ResolvedChatAssistantSurface[];
  /**
   * The conversation the viewer is standing in, if any — kept listed even
   * before its first message. See `sidebar-dm-lists`.
   */
  currentChannelId?: string;
  me: MeResponse | null;
  /**
   * The read-only system tier (`GET /api/agents?scope=all`). `agents` above
   * deliberately excludes it, so a global agent's home DM would otherwise
   * resolve to no agent at all and be dropped from the list entirely.
   */
  systemAgents: AgentRecord[];
  users: UserRecord[];
};

type UseSidebarDmsResult = {
  /**
   * Every person the viewer could hold a DM with, whether or not one has been
   * started. It backs the starred lookup and is not the Direct-messages list.
   */
  peopleDirectory: SidebarPerson[];
  sidebarAgentDms: SidebarAgentDm[];
  sidebarGroupDms: SidebarGroupDm[];
  sidebarPeople: SidebarPerson[];
  sidebarProductAssistants: SidebarProductAssistant[];
};

/**
 * Derives the Direct-messages section lists: the people rows, the product chat
 * assistants pinned under the Personal Assistant, and the generic agent DMs.
 * A channel surfaced as a pinned product assistant is de-duped out of the
 * generic agent-DM list so it never appears twice. The derivations themselves
 * are pure and live in `sidebar-dm-lists`, which is also where the rule that a
 * DM is listed only once it holds a conversation is stated.
 */
export const useSidebarDms = ({
  agents,
  channels,
  chatAssistants,
  currentChannelId,
  me,
  systemAgents,
  users,
}: UseSidebarDmsInput): UseSidebarDmsResult => {
  const peopleDirectory = useMemo<SidebarPerson[]>(
    () => resolvePeopleDirectory(me, users, channels),
    [channels, me, users],
  );

  const sidebarPeople = useMemo<SidebarPerson[]>(
    () => resolvePeopleWithConversations(peopleDirectory, channels, currentChannelId),
    [channels, currentChannelId, peopleDirectory],
  );

  // Product chat assistants declared by the surface registry, resolved to their
  // per-user external-agent channel. The external-agent channel carries no
  // product slug, but its label is the product name, so we match on that. When
  // the product is linked but its channel hasn't been bootstrapped yet the
  // surface simply doesn't appear (activation bootstraps the channel).
  const sidebarProductAssistants = useMemo<SidebarProductAssistant[]>(
    () =>
      chatAssistants.flatMap((assistant) => {
        const channel = channels.find(
          (candidate) =>
            isExternalAgentChannel(candidate) && candidate.label === assistant.productName,
        );
        if (!channel) return [];
        return [{
          dmChannelId: channel.id,
          productSlug: assistant.productSlug,
          label: assistant.label,
          iconGlyph: assistant.iconGlyph,
        }];
      }),
    [channels, chatAssistants],
  );

  const productAssistantChannelIds = useMemo(
    () => new Set(sidebarProductAssistants.map((assistant) => assistant.dmChannelId)),
    [sidebarProductAssistants],
  );

  const sidebarAgentDms = useMemo<SidebarAgentDm[]>(
    () =>
      resolveAgentDms({
        agents,
        channels,
        currentChannelId,
        pinnedChannelIds: productAssistantChannelIds,
        systemAgents,
      }),
    [agents, channels, currentChannelId, productAssistantChannelIds, systemAgents],
  );

  const sidebarGroupDms = useMemo<SidebarGroupDm[]>(
    () =>
      channels
        .filter((channel) => channel.isGroupDm === true)
        .map((channel) => ({ dmChannelId: channel.id, label: channel.label })),
    [channels],
  );

  return {
    peopleDirectory,
    sidebarAgentDms,
    sidebarGroupDms,
    sidebarPeople,
    sidebarProductAssistants,
  };
};
