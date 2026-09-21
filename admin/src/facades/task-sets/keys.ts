export const taskSetKeys = {
  all: ['task-sets'] as const,
  list: ['task-sets', 'list'] as const,
  detail: (id?: string) => ['task-sets', 'detail', id] as const,
  items: (id?: string) => ['task-sets', 'items', id] as const,
  item: (setId: string, itemId?: string) => ['task-sets', 'item', setId, itemId] as const,
  processors: ['task-sets', 'processors'] as const,
}
