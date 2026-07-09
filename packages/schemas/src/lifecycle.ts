import { z } from 'zod'

export const AgentStatusSchema = z.enum([
  'idle',
  'thinking',
  'executing',
  'waiting_approval',
  'error',
  'offline',
])
export type AgentStatus = z.infer<typeof AgentStatusSchema>

export const AgentKindSchema = z.enum(['shared', 'personal_assistant'])
export type AgentKind = z.infer<typeof AgentKindSchema>

export const AgentSurfacePolicySchema = z.enum(['shared', 'dm_only'])
export type AgentSurfacePolicy = z.infer<typeof AgentSurfacePolicySchema>

export const AgentDelegationModeSchema = z.enum([
  'none',
  'act_as_requesting_user',
])
export type AgentDelegationMode = z.infer<typeof AgentDelegationModeSchema>

export const SystemChannelTypeSchema = z.enum(['personal_assistant', 'external_agent'])
export type SystemChannelType = z.infer<typeof SystemChannelTypeSchema>

export const AgentTriggerTypeSchema = z.enum([
  'manual',
  'scheduled',
  'webhook',
  'event',
  'interval',
])
export type AgentTriggerType = z.infer<typeof AgentTriggerTypeSchema>

export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
])
export type RunStatus = z.infer<typeof RunStatusSchema>

export const TaskStatusSchema = z.enum([
  'inbox',
  'assigned',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
  'awaiting_approval',
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>
