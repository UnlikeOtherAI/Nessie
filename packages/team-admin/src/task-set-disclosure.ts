import { TaskSetDisclosureSchema, type TaskSetDisclosure } from '@nessie/schemas'

/** Internal provenance, never a field an agent supplies in its tool arguments. */
export type TaskSetReadObserver = (disclosure: TaskSetDisclosure) => void

export const mergeTaskSetDisclosure = (...values: unknown[]): TaskSetDisclosure => {
  const scopes = new Map<string, TaskSetDisclosure['basisScopes'][number]>()
  const sources = new Map<string, TaskSetDisclosure['disclosureSources'][number]>()
  for (const value of values) {
    if (value === undefined) continue
    const disclosure = TaskSetDisclosureSchema.parse(value)
    for (const scope of disclosure.basisScopes) scopes.set(JSON.stringify(scope), scope)
    for (const source of disclosure.disclosureSources) sources.set(JSON.stringify(source), source)
  }
  return { classified: true, basisScopes: [...scopes.values()], disclosureSources: [...sources.values()] }
}
