import { buildChannelMessagePath } from './navigation.js'

/** Canonical product destinations; routing on arrival remains the navigation
 * framework's responsibility and every destination enforces its normal access.
 */
export const buildNessieResourcePath = (input: Record<string, unknown>): string => {
  const value = (key: string): string => {
    const result = input[key]
    if (typeof result !== 'string' || !result.trim()) throw new Error(`${key} is required.`)
    return encodeURIComponent(result)
  }
  const id = value('id')
  switch (input.kind) {
    case 'agent': return `/agents/${id}`
    case 'executor': return `/agents/executors/${id}`
    case 'terminal': return `/agents/executors/${value('executorId')}/sessions/${id}`
    case 'trigger': return `/agents/triggers/${id}`
    case 'task_set': return `/agents/task-sets/${id}`
    case 'channel': return `/channels/${id}`
    case 'conversation': return `/channels/${value('channelId')}/threads/${id}`
    case 'message': return buildChannelMessagePath({
      channelId: value('channelId'), threadId: value('threadId'), messageId: id,
      ...(input.rootMessageId ? { rootMessageId: value('rootMessageId') } : {}),
    })
    case 'project': return `/projects/${id}`
    case 'board': return `/projects/${value('projectId')}/board?board=${id}`
    case 'ticket': return `/projects/${value('projectId')}/board?task=${id}`
    case 'dashboard': return `/projects/${value('projectId')}/dashboards/${id}`
    case 'space': return `/knowledge-base/spaces/${id}`
    case 'document': return `/knowledge-base/spaces/${value('spaceId')}?pageId=${id}`
    case 'app': return `/apps/${id}`
    case 'connection': return `/settings/connections/${id}`
    default: throw new Error('Choose a supported Nessie resource kind.')
  }
}
