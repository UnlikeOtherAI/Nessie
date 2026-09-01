import { useMemo } from 'react';
import {
  isExternalAgentChannel,
  isPersonalAssistantChannel,
  isUserDmChannel,
} from '../../facades/personal-assistant/hooks';
import type { ResolvedChatAssistantSurface } from '../../facades/integrations/useProductSurfaces';
import type { AgentRecord, ChannelRecord, MeResponse, UserRecord } from '../../lib/api-client';
import { getDmStyle } from '../../lib/avatar';
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
  me: MeResponse | null;
  users: UserRecord[];
};

type UseSidebarDmsResult = {
  sidebarAgentDms: SidebarAgentDm[];
  sidebarGroupDms: SidebarGroupDm[];
  sidebarPeople: SidebarPerson[];
  sidebarProductAssistants: SidebarProductAssistant[];
};

/**
 * Derives the Direct-messages section lists: the people row, the product chat
 * assistants pinned under the Personal Assistant, and the generic agent DMs.
 * A channel surfaced as a pinned product assistant is de-duped out of the
 * generic agent-DM list so it never appears twice.
 */
export const useSidebarDms = ({
  agents,
  channels,
  chatAssistants,
  me,
  users,
}: UseSidebarDmsInput): UseSidebarDmsResult => {
  const sidebarPeople = useMemo<SidebarPerson[]>(() => {
    if (!me) {
      return [];
    }

    const currentUser = users.find((u) => u.id === me.user.id);
    const people = [
      {
        id: me.user.id,
        label: me.user.displayName,
        avatarUrl: currentUser?.avatarUrl ?? me.user.avatarUrl ?? null,
        avatarAttachmentId: currentUser?.avatarAttachmentId ?? me.user.avatarAttachmentId ?? null,
        channelIds: currentUser?.channelIds ?? [],
      },
      ...users
        .filter((u) => u.id !== me.user.id)
        .map((user) => ({
          id: user.id,
          label: user.displayName,
          avatarUrl: user.avatarUrl,
          avatarAttachmentId: user.avatarAttachmentId,
          channelIds: user.channelIds,
        })),
    ];

    return people.slice(0, 4).map((person, index) => ({
      id: person.id,
      label: person.label,
      style: getDmStyle(index),
      avatarUrl: person.avatarUrl,
      avatarAttachmentId: person.avatarAttachmentId,
      dmChannelId: person.id === me.user.id
        ? undefined
        : channels.find(
          (c) => isUserDmChannel(c) && person.channelIds.includes(c.id),
        )?.id,
    }));
  }, [me, users, channels]);

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
      channels
        .filter((channel) => channel.type === 'dm' && !isPersonalAssistantChannel(channel))
        .filter((channel) => channel.isGroupDm !== true)
        // A channel pinned as a product assistant under the PA is never also
        // listed in the generic agent-DM list.
        .filter((channel) => !productAssistantChannelIds.has(channel.id))
        .flatMap((channel) => {
          const agent = agents.find((candidate) => candidate.channelIds.includes(channel.id));
          if (agent) {
            return [{
              dmChannelId: channel.id,
              id: agent.id,
              label: agent.name,
            }];
          }
          // External agents (DeepSignal, ...) bind a system-managed `Agent`
          // row that the general agent list excludes, so it never resolves
          // above — fall back to the channel's own label, keyed by channel id.
          if (isExternalAgentChannel(channel)) {
            return [{
              dmChannelId: channel.id,
              id: channel.id,
              label: channel.label,
            }];
          }
          return [];
        }),
    [agents, channels, productAssistantChannelIds],
  );

  const sidebarGroupDms = useMemo<SidebarGroupDm[]>(
    () =>
      channels
        .filter((channel) => channel.isGroupDm === true)
        .map((channel) => ({ dmChannelId: channel.id, label: channel.label })),
    [channels],
  );

  return { sidebarAgentDms, sidebarGroupDms, sidebarPeople, sidebarProductAssistants };
};
