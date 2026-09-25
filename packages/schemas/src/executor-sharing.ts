import { z } from 'zod'

export const ExecutorListQuerySchema = z.object({ projectId: z.string().uuid().optional() }).strict()

export const ExecutorSharingChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), userId: z.string().uuid(), role: z.enum(['use', 'admin']).nullable() }).strict(),
  z.object({ kind: z.literal('project'), projectId: z.string().uuid(), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('team'), enabled: z.boolean() }).strict(),
])
export type ExecutorSharingChange = z.infer<typeof ExecutorSharingChangeSchema>

export const ExecutorSharingUpdateSchema = z.object({
  teamId: z.string().uuid(), change: ExecutorSharingChangeSchema,
}).strict()

export const ExecutorSharingViewSchema = z.object({
  executorId: z.string().uuid(),
  teamId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  everyone: z.boolean(),
  people: z.array(z.object({ userId: z.string().uuid(), name: z.string(), role: z.enum(['use', 'admin']) }).strict()),
  projects: z.array(z.object({ projectId: z.string().uuid(), name: z.string() }).strict()),
  availablePeople: z.array(z.object({ userId: z.string().uuid(), name: z.string() }).strict()),
  availableProjects: z.array(z.object({ projectId: z.string().uuid(), name: z.string() }).strict()),
}).strict()
export type ExecutorSharingView = z.infer<typeof ExecutorSharingViewSchema>
