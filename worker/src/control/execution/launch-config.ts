import { asObject, parseStringRecord } from './stored-json.js'

export const mergeLaunchConfig = (
  templateConfig: unknown,
  instanceConfig: unknown,
): Record<string, unknown> => {
  const templateRecord = asObject(templateConfig)
  const instanceRecord = asObject(instanceConfig)

  return {
    ...templateRecord,
    ...instanceRecord,
    env: {
      ...parseStringRecord(templateRecord['env']),
      ...parseStringRecord(instanceRecord['env']),
    },
    labels: {
      ...parseStringRecord(templateRecord['labels']),
      ...parseStringRecord(instanceRecord['labels']),
    },
    metadata: {
      ...parseStringRecord(templateRecord['metadata']),
      ...parseStringRecord(instanceRecord['metadata']),
    },
  }
}
