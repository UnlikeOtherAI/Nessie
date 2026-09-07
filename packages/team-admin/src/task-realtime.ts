import type { PgRealtimeTransport } from '@nessie/runtime'
import { parseTaskId, type TaskStatus, type WsScope } from '@nessie/schemas'

export const publishTaskUpdated = async (
  transport: Pick<PgRealtimeTransport, 'publishWs'>,
  scopes: WsScope[],
  taskId: string,
  status: TaskStatus,
): Promise<void> => transport.publishWs(scopes, {
  data: { taskId: parseTaskId(taskId), status },
  event: 'task.updated',
})
