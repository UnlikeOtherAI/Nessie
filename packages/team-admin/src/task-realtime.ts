import type { PgRealtimeTransport } from '@nessie/runtime'
import { parseTaskId, type TaskStatus, type WsScope } from '@nessie/schemas'

export const publishTaskUpdated = async (
  transport: Pick<PgRealtimeTransport, 'publishWs'>,
  scopes: WsScope[],
  taskId: string,
  status: TaskStatus,
  options: { idempotencyKey?: string; timestamp?: string } = {},
): Promise<void> => {
  await transport.publishWs(scopes, {
    data: { taskId: parseTaskId(taskId), status },
    event: 'task.updated',
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.timestamp ? { ts: options.timestamp } : {}),
  })
}
