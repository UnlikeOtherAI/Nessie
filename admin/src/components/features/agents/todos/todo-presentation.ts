import type {
  AgentTodoActorType,
  AgentTodoStatus,
  AgentTodoStepStatus,
  AgentTodoTemplateStatus,
} from '@nessie/schemas'

import type { PillTone } from '../../../primitives/Pill'

export const todoStatusTone = (status: AgentTodoStatus): PillTone => {
  switch (status) {
    case 'completed':
      return 'success'
    case 'cancelled':
      return 'muted'
    case 'running':
      return 'accent'
    case 'open':
      return 'warning'
  }
}

export const templateStatusTone = (status: AgentTodoTemplateStatus): PillTone => {
  switch (status) {
    case 'active':
      return 'success'
    case 'draft':
      return 'warning'
    case 'archived':
      return 'muted'
  }
}

export const stepStatusTone = (status: AgentTodoStepStatus): PillTone => {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'danger'
    case 'skipped':
      return 'muted'
    case 'running':
      return 'accent'
    case 'pending':
      return 'warning'
  }
}

export const changedByLabel = (actorType: AgentTodoActorType | null): string => {
  if (actorType === 'agent') return 'the agent'
  if (actorType === 'user') return 'a person'
  return 'not yet changed'
}

export const formatTodoTimestamp = (value: string): string =>
  new Date(value).toLocaleString()
