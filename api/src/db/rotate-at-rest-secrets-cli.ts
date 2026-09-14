import { pathToFileURL } from 'node:url'

import { loadConfig, resolveEncryptionKeyRing } from '@nessie/config'
import { disconnectPrismaClient, getPrismaClient } from '@nessie/db'

import { rotateDurableAtRestSecrets } from '../services/at-rest-secret-rotation.js'

const parseBatchSize = (args: readonly string[]): number | undefined => {
  if (args.length === 0) return undefined
  if (args.length !== 2 || args[0] !== '--batch-size') {
    throw new Error('Usage: rotate:at-rest-secrets [--batch-size 1..1000]')
  }
  const value = Number(args[1])
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error('rotate:at-rest-secrets requires an integer batch size from 1 to 1000.')
  }
  return value
}

const conflictCount = (result: Record<string, { conflicts: number }>): number =>
  Object.values(result).reduce((total, store) => total + store.conflicts, 0)

const exitCodeFor = (result: Record<string, { conflicts: number }>): 0 | 2 =>
  conflictCount(result) > 0 ? 2 : 0

/**
 * Operator-only at-rest rotation entry point. It intentionally has no HTTP
 * route: operators run it after deploying an active ring with retained roots.
 */
const main = async (): Promise<0 | 1 | 2> => {
  let prisma: ReturnType<typeof getPrismaClient> | undefined
  try {
    const batchSize = parseBatchSize(process.argv.slice(2))
    const config = loadConfig()
    const encryptionKeyRing = resolveEncryptionKeyRing(config, config.auth.secret)
    prisma = getPrismaClient()
    const result = await rotateDurableAtRestSecrets(prisma, encryptionKeyRing, {
      ...(batchSize === undefined ? {} : { batchSize }),
    })
    console.log(JSON.stringify(result))
    return exitCodeFor(result)
  } catch (error) {
    console.error('At-rest secret rotation failed:', error)
    return 1
  } finally {
    if (prisma) await disconnectPrismaClient()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((exitCode) => {
    process.exitCode = exitCode
  })
}

export { conflictCount, exitCodeFor, parseBatchSize }
