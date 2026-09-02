import type { ChannelRecord } from '../../lib/api-client'

// The channel-kind predicates live apart from the facade's react-query hooks
// so a caller that only needs to ask what a channel IS — the sidebar's DM
// derivation, for one — does not pull the query client in behind it. One
// definition; `hooks` re-exports them for the existing call sites.
export const isPersonalAssistantChannel = (channel?: ChannelRecord | null): boolean =>
  channel?.systemChannelType === 'personal_assistant'
  || channel?.metadata?.systemChannelType === 'personal_assistant'

// External agents (e.g. DeepSignal) are a peer of the Personal Assistant: a
// per-user private DM channel proxied to an external product over MCP, keyed
// by `systemChannelType` the same way the PA channel is. New external agents
// are a data change on the backend, not a UI code fork — this predicate stays
// generic across all of them.
export const isExternalAgentChannel = (channel?: ChannelRecord | null): boolean =>
  channel?.systemChannelType === 'external_agent'
  || channel?.metadata?.systemChannelType === 'external_agent'

// A global agent (the Agent Designer, ...) lives in a per-user private DM of
// its own, keyed by `systemChannelType` exactly as the two above are. New
// global agents are a backend blueprint entry, not a UI code fork.
export const isGlobalAgentChannel = (channel?: ChannelRecord | null): boolean =>
  channel?.systemChannelType === 'system_agent'
  || channel?.metadata?.systemChannelType === 'system_agent'

export const isUserDmChannel = (channel?: ChannelRecord | null): boolean =>
  channel?.type === 'dm'
  && !isPersonalAssistantChannel(channel)
  && !isExternalAgentChannel(channel)
  && !isGlobalAgentChannel(channel)
  && Boolean(channel.dmUserId)
