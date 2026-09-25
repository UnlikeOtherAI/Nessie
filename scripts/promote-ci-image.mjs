// Presence of this file is the CI image artifact contract for this revision.
// Revisions predating it still use Deploy's legacy Docker build path.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function promoteImage({ archive, name, sha, prefix }, docker) {
  if (!archive || !['app', 'admin', 'web'].includes(name) || !/^[a-f0-9]{40}$/.test(sha ?? '')
    || !/^ghcr\.io\/[a-z0-9_-]+\/nessie$/.test(prefix ?? '')) {
    throw new Error('Invalid production image identity')
  }
  const source = `nessie-ci-${name}:${sha}`
  const target = `${prefix}-${name}:${sha}`
  docker(['load', '--input', archive])
  const [image] = JSON.parse(docker(['image', 'inspect', source]))
  if (image?.Config?.Labels?.['org.opencontainers.image.revision'] !== sha) {
    throw new Error('CI image revision does not match the gated SHA')
  }
  docker(['tag', source, target])
  docker(['push', target])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const docker = (args) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    if (result.error || result.status !== 0) throw new Error(`docker ${args[0]} failed`)
    return result.stdout
  }
  promoteImage({
    archive: process.env.IMAGE_ARCHIVE,
    name: process.env.IMAGE_NAME,
    sha: process.env.IMAGE_SHA,
    prefix: process.env.IMAGE_PREFIX,
  }, docker)
}
