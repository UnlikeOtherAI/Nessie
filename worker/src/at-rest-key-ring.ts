import { loadConfig, resolveEncryptionKeyRing } from '@nessie/config'

/**
 * Worker tool modules run below the composition root, so they obtain the same
 * validated at-rest ring here rather than reaching for the signing secret.
 */
export const resolveWorkerAtRestKeyRing = () => {
  const config = loadConfig()
  return resolveEncryptionKeyRing(config, config.auth.secret)
}
